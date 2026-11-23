import { peerStorage } from '../client/keys'
import { peerChat } from '../actions/p2p_chat'
import { ForwardBar } from '../../components/forwards'
import { P2pProvider } from '../client/p2p_react'
import { parseForward, forwardValue } from '../forward'
import { testAccount } from './test_account'
import { AccountProvider } from '../client/react'
import { createPeerFixture } from './peer_fixture'
import { AccountSession } from '../client/session'
const peerOwner = new AccountSession(home)
const peerApp = createPeerFixture(peerOwner, 'bob')
const {
  mirrorFrom,
  p2pAccount,
  profileName,
  tellBadge,
  useP2p,
  put,
  p2p,
  p2pDm,
  p2pHost,
  p2pMarkAll,
  p2pServer,
} = peerApp
import 'fake-indexeddb/auto'
import { afterAll, afterEach, beforeEach, beforeAll, describe, expect, test } from 'bun:test'
import { openDB } from 'idb'
import { renderToStaticMarkup } from 'react-dom/server'
import type { ReactElement } from 'react'
import { AppRouterContext } from 'next/dist/shared/lib/app-router-context.shared-runtime'
import type { AppRouterInstance } from 'next/dist/shared/lib/app-router-context.shared-runtime'
import { maskOf, type ContextMenuItem } from '../store'
import { resetMasking, setMasking } from '../profanity'
import { DEFAULT_VIEW, type InboxView } from '../inbox'
const { addInboxAdapter, removeInboxAdapter } = peerOwner.inbox
import { EMPTY_NOTIFY, setLevel } from '../notify'
import { parseHome, pushP2pRecent, recentKey, recentShown } from '../home'
import { messageItems, type ResultCtx } from '../palette_results'
import { PaletteIndex } from '../palette_index'
import { p2pKey, type P2pState } from '../p2p/app'
import { blankRoom } from '../p2p/dag'

import { P2pStore } from '../p2p/db'
import { createP2pApp } from '../p2p/app/runtime'
import { home } from './home_instance'
import { P2pOffSection, P2pSection } from '../../components/p2p/p2p_settings'
import type { Fwd } from '../p2p/content'
import { useP2pList } from '../../components/p2p/p2p_chat'
import type { Contact } from '../p2p/contacts'
import { keyId, newKeyPair } from '../p2p/keys'
import type { OwnBadge, RoomRecord } from '../p2p/db'
import type { P2pMessage } from '../p2p/dm'
import type { ServerView } from '../p2p/server'
import { p2pUnread } from '../p2p/alerts'
import {
  addPings,
  byCounter,
  logValue,
  markAllTargets,
  markSeen,
  newerFirst,
  pagePings,
  parseLog,
  pingEntry,
  pingInView,
  pingUnread,
  pingVisible,
  readSeqs,
  P2P_DM_LABEL,
  type PingRec,
  type PingWorld,
} from '../p2p/inbox'
import { LOCAL, type Local } from '../p2p/limits'

import {
  listedIn,
  pingInputsChanged,
  pingNotifies,
  createP2pInbox,
  startP2pPings,
  p2pPingCount,
  worldOf,
} from '../p2p/inbox_source'
import {
  bucketPlace,
  p2pBucket,
  p2pDoc,
  p2pDocPlace,
  p2pDocVisible,
  createIndexSource,
  placesOf,
} from '../p2p/palette_source'
const { __sync, indexDocs, paletteIndex, registerIndexSource } = peerOwner.indexer
import { startP2pIndex } from '../p2p/palette_source'
import { ServerRail } from '../../components/server_rail'
import { ChannelSidebar } from '../../components/channel_sidebar'
import { dmRoomId } from '../p2p/dm'
import type { DmSummary } from '../types'
import { InboxButton } from '../../components/inbox'
import { P2pHome } from '../../components/p2p/p2p_home'
import { memberMenu, P2pMemberList, P2pServerSidebar } from '../../components/p2p/p2p_server_view'
import { P2pDmPane } from '../../components/p2p/p2p_dm_pane'
import { AccountChip } from '../../components/p2p/p2p_badge'
import { ServerSettingsDialog } from '../../components/p2p/p2p_server_settings'
import { ServerInviteDialog, ServerNewDialog } from '../../components/p2p/p2p_invite_dialog'
import { CallBanner } from '../../components/voice_grid'
import { markAllReadItem, registerAppActions } from '../actions'

import { me, memoryStorage, user } from './fixtures'
import { readText } from './masked_text'

beforeAll(registerAppActions)
afterAll(() => peerOwner.store.dispose())

const NOW = 1_800_000_000_000
const ROOM = 'dm-room'
const SRV = 'srv-room'
const CH = 'chan1'
const ik = () => keyId(newKeyPair().pk)
const ALICE = ik()
const BOB = ik()
const CAROL = ik()

const ping = (id: string, over: Partial<PingRec> = {}): PingRec => ({
  id,
  room: ROOM,
  ch: null,
  kind: 'mention',
  actor: ALICE,
  at: NOW,
  seq: 10,
  emoji: null,
  target: null,
  seen: false,
  ...over,
})

const contact = (ik: string, name: string, state: Contact['state'] = 'mutual'): Contact => ({
  ik,
  name,
  petname: null,
  profile: null,
  certs: [],
  revocations: [],
  state,
  ignored: false,
  intros: [],
  verified: false,
  verifiedAt: null,
  warning: null,
  notice: null,
  host: 'x',
  added: 0,
  lastSeen: null,
})

const server = (over: Partial<ServerView> = {}): ServerView => ({
  id: SRV,
  name: 'Book club',
  color: null,
  me: 'join',
  joining: false,
  owner: ALICE,
  owners: [ALICE],
  perms: 0,
  rank: [Infinity, ''],
  roles: [],
  everyone: 0,
  history: 'shared',
  system: { ch: CH, join: true, leave: true },
  channels: [
    { id: CH, name: 'general', kind: 'text', pos: 0, send: true, exempt: false, over: {} },
  ],
  members: [],
  online: 0,
  joined: 2,
  chans: {},
  seq: 0,
  gap: false,
  full: false,
  readOnly: null,
  voice: {},
  mods: [],
  reached: [],
  reapply: [],
  joinWait: null,
  conflict: false,
  syncing: null,
  upgraded: false,
  disputed: false,
  next: null,
  prev: null,
  carry: null,
  migrateDiff: null,
  ...over,
})

const world = (over: Partial<PingWorld> = {}): PingWorld => ({
  readSeq: new Map([
    [ROOM, 5],
    [`${SRV}/${CH}`, 5],
  ]),
  dms: new Map([[ROOM, ALICE]]),
  contacts: new Set([ALICE, CAROL]),
  blocked: new Set(),
  servers: { [SRV]: server() },
  ...over,
})

const view = (over: Partial<InboxView> = {}): InboxView => ({ ...DEFAULT_VIEW, ...over })

describe('P2P inbox: arrival time', () => {
  test('time, order, paging and the mark-all bound go by arrival, not the sender clock', () => {
    const seqs = new Map([[ROOM, 0]])
    // Sent while we were offline: its message carries an old time, but it came in after the
    // list was shown.
    const late = ping('a-late', { at: NOW + 30 })
    const top = ping('top', { at: NOW + 20 })
    const old = ping('old', { at: NOW })
    const list = [late, top, old]
    expect(markAllTargets(list, view(), [top], seqs).map(p => p.id)).toEqual(['top', 'old'])
    expect([...list].sort(newerFirst).map(p => p.id)).toEqual(['a-late', 'top', 'old'])
    const first = pagePings([...list].sort(newerFirst), null, 1)
    expect(first.page.map(p => p.id)).toEqual(['a-late'])
    expect(pagePings([...list].sort(newerFirst), first.next, 5).page.map(p => p.id)).toEqual([
      'top',
      'old',
    ])
    const entry = pingEntry(late, world(), 'Alice', {
      content: 'x',
      media: null,
      mediaSpoiler: false,
    })
    expect([entry.created_at, entry.order]).toEqual([Math.floor((NOW + 30) / 1000), NOW + 30])
  })
})

describe('P2P inbox: the noted pings', () => {
  test('the stored list is read defensively and pings are kept once, newest, for 30 days', () => {
    expect(parseLog(null)).toEqual([])
    expect(parseLog({ v: 2, list: [ping('a')] })).toEqual([])
    const stored = logValue([
      ping('a'),
      ping('a', { seq: 99 }),
      { ...ping('b'), kind: 'shout' } as unknown as PingRec,
      { ...ping('c'), at: -1 },
      ping('d', { ch: CH, room: SRV, emoji: '🎉', kind: 'reaction', target: 'm1' }),
    ])
    const list = parseLog(JSON.parse(JSON.stringify(stored)))
    expect(list.map(p => p.id)).toEqual(['a', 'd'])
    expect(list[0].seq).toBe(10)
    expect(list[1]).toMatchObject({ kind: 'reaction', emoji: '🎉', target: 'm1', ch: CH })

    const old = ping('old', { at: NOW - LOCAL.inbox.pingKeepMs - 1 })
    const added = addPings(
      [old, ping('a')],
      [ping('a', { seq: 50 }), ping('n', { at: NOW + 5 })],
      NOW
    )
    expect(added.map(p => p.id)).toEqual(['n', 'a'])
    expect(added[1].seq).toBe(10)
    const many = Array.from({ length: LOCAL.inbox.pingsKept + 20 }, (_, i) =>
      ping(`p${i}`, { at: NOW + i })
    )
    const capped = addPings([], many, NOW)
    expect(capped.length).toBe(LOCAL.inbox.pingsKept)
    expect(capped[0].id).toBe(`p${LOCAL.inbox.pingsKept + 19}`)
  })

  test('a ping is read when marked, or when its conversation or channel was read past it', () => {
    const rooms = [
      { id: ROOM, kind: 'dm', readSeq: 7 },
      {
        id: SRV,
        kind: 'server',
        readSeq: 0,
        chans: { [CH]: { unread: 0, pings: 0, readSeq: 12 } },
      },
    ] as unknown as RoomRecord[]
    const seqs = readSeqs(rooms)
    expect([...seqs]).toEqual([
      [ROOM, 7],
      [`${SRV}/${CH}`, 12],
    ])
    expect(pingUnread(ping('a', { seq: 7 }), seqs)).toBe(false)
    expect(pingUnread(ping('a', { seq: 8 }), seqs)).toBe(true)
    expect(pingUnread(ping('a', { seq: 8, seen: true }), seqs)).toBe(false)
    expect(pingUnread(ping('a', { room: SRV, ch: CH, seq: 12 }), seqs)).toBe(false)
    expect(pingUnread(ping('a', { room: SRV, ch: 'other', seq: 1 }), seqs)).toBe(true)
    expect(markSeen([ping('a'), ping('b')], new Set(['b'])).map(p => p.seen)).toEqual([false, true])
  })

  test('pings map to inbox entries with their place, time and order', () => {
    const w = world()
    const dm = pingEntry(ping('e1', { at: NOW + 1234 }), w, 'Alice', {
      content: 'hey @Bob',
      media: null,
      mediaSpoiler: false,
    })
    expect(dm).toMatchObject({
      key: 'p2p:e1',
      adapter: 'p2p',
      created_at: Math.floor((NOW + 1234) / 1000),
      order: NOW + 1234,
      unread: true,
      kind: 'mention',
      emoji: null,
      role: null,
      where: { kind: 'other', label: P2P_DM_LABEL },
      content: 'hey @Bob',
    })
    expect(dm.actor).toMatchObject({ username: ALICE, display_name: 'Alice' })
    const reaction = pingEntry(
      ping('e2', { room: SRV, ch: CH, kind: 'reaction', emoji: '👍', target: 'm1', seq: 3 }),
      w,
      'Alice',
      { content: 'my message', media: 'cat.png', mediaSpoiler: true }
    )
    expect(reaction).toMatchObject({
      unread: false,
      kind: 'reaction',
      emoji: '👍',
      where: {
        kind: 'channel',
        server: SRV,
        serverName: 'Book club',
        channel: 'general',
        thread: false,
      },
      media: 'cat.png',
      mediaSpoiler: true,
    })
  })

  test('only open places show: blocked people, left servers and gone channels drop out', () => {
    const w = world()
    expect(pingVisible(ping('a'), w)).toBe(true)
    expect(pingVisible(ping('a'), world({ blocked: new Set([ALICE]) }))).toBe(false)
    expect(pingVisible(ping('a'), world({ contacts: new Set() }))).toBe(false)
    expect(pingVisible(ping('a', { room: 'unknown' }), w)).toBe(false)
    const inServer = ping('s', { room: SRV, ch: CH, actor: CAROL })
    expect(pingVisible(inServer, w)).toBe(true)
    expect(pingVisible(inServer, world({ blocked: new Set([CAROL]) }))).toBe(false)
    for (const me of ['leave', 'ban', 'invite', null] as const)
      expect(pingVisible(inServer, world({ servers: { [SRV]: server({ me }) } }))).toBe(false)
    expect(pingVisible(inServer, world({ servers: { [SRV]: server({ channels: [] }) } }))).toBe(
      false
    )
    expect(pingVisible(inServer, world({ servers: {} }))).toBe(false)
  })

  test('filters: kinds, direct messages, and nothing for an instance server', () => {
    const everyone = ping('e', { kind: 'everyone', room: SRV, ch: CH })
    const reply = ping('r', { kind: 'reply' })
    expect(pingInView(everyone, view({ kind: 'mentions' }))).toBe(true)
    expect(pingInView(reply, view({ kind: 'mentions' }))).toBe(false)
    expect(pingInView(reply, view({ kind: 'replies' }))).toBe(true)
    expect(pingInView(reply, view({ kind: 'friends' }))).toBe(false)
    expect(pingInView(reply, view({ place: 'dms' }))).toBe(true)
    expect(pingInView(everyone, view({ place: 'dms' }))).toBe(false)
    expect(pingInView(reply, view({ place: 'some-server' }))).toBe(false)
    expect(pingInView(everyone, view({ place: SRV }))).toBe(false)
  })

  test('the Unread tab leaves out conversations and channels set to "Nothing"', () => {
    const prefs = setLevel(EMPTY_NOTIFY, { kind: 'p2p', room: ROOM }, 'nothing')
    expect(pingNotifies(prefs, ping('a'))).toBe(false)
    expect(pingNotifies(prefs, ping('a', { room: SRV, ch: CH }))).toBe(true)
    const off = setLevel(EMPTY_NOTIFY, { kind: 'p2ps', room: SRV }, 'nothing')
    expect(pingNotifies(off, ping('a', { room: SRV, ch: CH }))).toBe(false)
  })

  test('mark all in the Unread tab leaves pings in "Nothing" scopes alone, like the list', () => {
    const prefs = setLevel(EMPTY_NOTIFY, { kind: 'p2p', room: ROOM }, 'nothing')
    const w = world({ readSeq: new Map() })
    const list = [
      ping('dm', { at: NOW + 2 }),
      ping('ch', { room: SRV, ch: CH, actor: CAROL, at: NOW + 1 }),
    ]
    const unread = view({ unread: true })
    const shown = list.filter(listedIn(unread, w, prefs))
    expect(shown.map(p => p.id)).toEqual(['ch'])
    const marked = (v: InboxView) =>
      markAllTargets(list.filter(listedIn(v, w, prefs)), v, shown, w.readSeq).map(p => p.id)
    expect(marked(unread)).toEqual(['ch'])
    // The All tab lists both, so it marks both (from the newest shown down).
    expect(marked(view({ unread: false }))).toEqual(['ch'])
    const all = view({ unread: false })
    expect(
      markAllTargets(list.filter(listedIn(all, w, prefs)), all, list, w.readSeq).map(p => p.id)
    ).toEqual(['dm', 'ch'])
  })

  test('pages cover the list without holes or repeats', () => {
    const list = Array.from({ length: 23 }, (_, i) =>
      ping(`p${String(i).padStart(2, '0')}`, { at: NOW + Math.floor(i / 3) })
    ).sort(newerFirst)
    for (const size of [1, 2, 5, 7, 30]) {
      const got: string[] = []
      let cursor: string | null = null
      for (let i = 0; i < 50; i++) {
        const { page, next } = pagePings(list, cursor, size)
        got.push(...page.map(p => p.id))
        if (next === null) break
        cursor = next
      }
      expect(got).toEqual(list.map(p => p.id))
    }
    expect(pagePings(list, 'garbage', 5).page).toEqual([])
  })

  test('mark all goes down from the newest shown ping and keeps to the view', () => {
    const seqs = new Map([[ROOM, 0]])
    const list = [
      ping('new', { at: NOW + 30 }),
      ping('top', { at: NOW + 20 }),
      ping('mid', { at: NOW + 10, kind: 'reply' }),
      ping('old', { at: NOW }),
      ping('done', { at: NOW - 5, seen: true }),
    ]
    const shown = [list[1], list[2]]
    expect(markAllTargets(list, view(), shown, seqs).map(p => p.id)).toEqual(['top', 'mid', 'old'])
    expect(markAllTargets(list, view({ kind: 'replies' }), shown, seqs).map(p => p.id)).toEqual([
      'mid',
    ])
    expect(markAllTargets(list, view(), [], seqs)).toEqual([])
    const cuts = byCounter([ping('a'), ping('b'), ping('c', { room: SRV, ch: CH })])
    expect([...cuts]).toEqual([
      [ROOM, 2],
      [`${SRV}/${CH}`, 1],
    ])
  })
})

// Server rendering reads each store's initial state, so the test state goes there.
const accountStore = peerOwner.store
const initial = accountStore.getInitialState()
const saved = { ...initial }
const p2pInitial = useP2p.getInitialState()
const p2pSaved = { ...p2pInitial }

const router = {
  push: () => {},
  replace: () => {},
  back: () => {},
  forward: () => {},
  refresh: () => {},
  prefetch: () => {},
} as unknown as AppRouterInstance

const render = (node: ReactElement) =>
  renderToStaticMarkup(
    <AccountProvider session={peerOwner}>
      <AppRouterContext.Provider value={router}>{node}</AppRouterContext.Provider>
    </AccountProvider>
  )

const p2pState = (over: Partial<P2pState>) => {
  Object.assign(p2pInitial, p2pSaved, over)
  useP2p.setState(p2pInitial)
}

afterEach(() => {
  Object.assign(initial, saved)
  Object.assign(p2pInitial, p2pSaved)
  useP2p.setState(p2pSaved)
  accountStore.setState(saved)
  resetMasking()
})

describe('the P2P DM header', () => {
  const longChat = (over: Partial<Contact> = {}) => {
    const long = 'Bartholomew Featherstonehaugh-Wo'
    p2pState({
      enabled: true,
      account: 'bob',
      me: BOB,
      name: 'Bob',
      status: 'online',
      home: true,
      contacts: [{ ...contact(ALICE, long), ...over }],
      rooms: {
        [ROOM]: { id: ROOM, peer: ALICE, seq: 0, unread: 0, pings: 0, lastTs: NOW },
      } as unknown as P2pState['rooms'],
      chat: {
        room: ROOM,
        peer: ALICE,
        messages: [],
        more: false,
        loading: false,
        readSeq: 0,
        missed: [],
      },
    })
    const html = render(<P2pDmPane onBack={() => {}} onMenu={() => {}} />)
    return { long, header: html.slice(html.indexOf('<header'), html.indexOf('</header>')) }
  }
  const contactButton = (header: string) =>
    header.match(/<button([^>]*)><span class="relative shrink-0"><img /)?.[1] ?? ''

  test('the avatar keeps its size and the name truncates, with the full name as its title', () => {
    Object.assign(initial, { me: me('bob'), streamer: false })
    const { long, header } = longChat()
    const avatar = header.match(/<span class="([^"]*)"><img [^>]*width="28" height="28"/)
    expect(avatar?.[1].split(' ')).toContain('shrink-0')
    const name = header.match(/<span id="[^"]*" title="([^"]*)" class="([^"]*)">([^<]*)</)
    expect(name?.[1]).toBe(long)
    expect(name?.[3]).toBe(long)
    const classes = name?.[2].split(' ') ?? []
    for (const c of ['streamer', 'min-w-0', 'truncate']) expect(classes).toContain(c)
  })

  test('below 360 px the contact shows only its avatar and shield, named by its title and label', () => {
    Object.assign(initial, { me: me('bob'), streamer: false })
    for (const [over, kind, label] of [
      [{}, 'unverified', 'Not verified'],
      [{ verified: true }, 'verified', 'Verified'],
      [{ warning: 'new key' }, 'warning', 'Identity warning'],
    ] as const) {
      const { long, header } = longChat(over)
      const button = contactButton(header)
      expect(button).toContain(`title="${long}"`)
      const ids = button.match(/aria-labelledby="([^"]*)"/)?.[1].split(' ') ?? []
      expect(ids).toHaveLength(3)
      const element = (id: string) =>
        header.match(new RegExp(`<span id="${id}"([^>]*)>(.*?)</span>`))
      const text = (id: string) => element(id)?.[2].replace(/<[^>]*>/g, '')
      expect(text(ids[0])).toBe(long)
      expect(element(ids[1])?.[1]).toContain(`aria-label="${label}"`)
      expect(element(ids[1])?.[1]).toContain(`data-shield="${kind}"`)
      expect(text(ids[2])).toContain(long)
      const column = header.match(
        /<span class="([^"]*)"><span class="flex min-w-0 items-center gap-1.5">/
      )
      expect(column?.[1].split(' ')).toContain('max-[360px]:hidden')
      const avatar =
        header.match(
          /<span class="relative shrink-0">(.*?)<\/span><span class="flex min-w-0 flex-col/
        )?.[1] ?? ''
      const onAvatar = avatar.match(/<span class="([^"]*)"><span[^>]*data-shield="([^"]*)"/)
      expect(onAvatar?.[2]).toBe(kind)
      const classes = onAvatar?.[1].split(' ') ?? []
      for (const c of ['absolute', 'hidden', 'max-[360px]:flex']) expect(classes).toContain(c)
    }
  })

  test('in streamer mode the contact button and name have no title with the name', () => {
    Object.assign(initial, { me: me('bob'), streamer: true })
    const { long, header } = longChat()
    expect(header).not.toContain(`title="${long}"`)
    expect(contactButton(header)).toContain('title="Contact"')
  })
})

describe('rail', () => {
  const homeButton = (html: string) => html.match(/<button[^>]*data-home-button[^>]*>/)?.[0] ?? ''

  test('Home yields to the P2P home and P2P servers like every other rail item', () => {
    Object.assign(initial, { me: me('bob'), home: true, view: null })
    p2pState({ enabled: true, account: 'bob' })
    const atHome = homeButton(render(<ServerRail />))
    expect(atHome).toContain('aria-current="page"')
    expect(atHome).toContain('bg-primary')

    p2pState({ enabled: true, account: 'bob', home: true })
    const html = render(<ServerRail />)
    expect(homeButton(html).includes('aria-current')).toBe(false)
    expect(homeButton(html).includes('bg-primary ')).toBe(false)
    expect(/<button[^>]*data-p2p-tile[^>]*aria-pressed="true"/.test(html)).toBe(true)

    p2pState({
      enabled: true,
      account: 'bob',
      servers: { [SRV]: server() },
      server: { room: SRV, ch: CH },
    })
    const inServer = render(<ServerRail />)
    expect(homeButton(inServer).includes('aria-current')).toBe(false)
    expect(/data-p2p-server="srv-room"[^>]*aria-current="page"/.test(inServer)).toBe(true)
  })

  test('without P2P from the instance the rail has no P2P tile or servers', () => {
    Object.assign(initial, { me: me('bob'), home: true, view: null })
    p2pState({ enabled: true, account: 'bob', servers: { [SRV]: server() } })
    expect(render(<ServerRail />)).toContain('data-p2p-tile')
    p2pState({ enabled: true, account: null, servers: { [SRV]: server() } })
    const off = render(<ServerRail />)
    expect(off).not.toContain('data-p2p-tile')
    expect(off).not.toContain('data-p2p-server')
    expect(homeButton(off)).toContain('aria-current="page"')
  })
})

describe('P2P switched off on the instance', () => {
  let offline: AccountSession
  beforeEach(() => {
    offline = new AccountSession(home)
    offline.store.setState(s => ({
      me: me('bob'),
      guest: false,
      settings: { ...s.settings, p2p: false },
    }))
    Object.assign(offline.store.getInitialState(), offline.store.getState())
  })
  afterEach(() => offline.store.dispose())
  const offSection = () =>
    render(
      <AccountProvider session={offline}>
        <P2pOffSection />
      </AccountProvider>
    )
  const db = () => peerStorage(home, 'bob').db!
  const stored = async () => (await indexedDB.databases()).some(d => d.name === db())
  const settings = (p2p: boolean) => ({ ...saved.settings, p2p })

  test('Settings removes P2P data from this browser, and the database is gone', async () => {
    localStorage.setItem(
      peerStorage(home, 'bob').scoped(p2pKey('bob')),
      JSON.stringify({ v: 1, on: true })
    )
    ;(await openDB(db(), 1)).close()
    expect(await stored()).toBe(true)
    const off = offSection()
    expect(off).toContain(`P2P is off on <span class="streamer">${home.host}</span>.`)
    expect(off).toContain('Remove P2P data from this browser')
    Object.assign(offline.store.getInitialState(), { settings: settings(true) })
    expect(offSection()).toBe('')
    expect(await offline.identities.offlineData()[0]!.remove()).toBe(true)
    expect(await stored()).toBe(false)
    expect(localStorage.getItem(peerStorage(home, 'bob').scoped(p2pKey('bob')))).toBeNull()
    expect(offline.identities.list()).toEqual([])
    Object.assign(offline.store.getInitialState(), { settings: settings(false) })
    expect(offSection()).toBe('')
  })

  test('after a failed remove, Settings offers removing the data that is left', async () => {
    localStorage.setItem(
      peerStorage(home, 'bob').scoped(p2pKey('bob')),
      JSON.stringify({ v: 1, on: true })
    )
    ;(await openDB(db(), 1)).close()
    const del = indexedDB.deleteDatabase
    indexedDB.deleteDatabase = () => {
      throw new Error('denied')
    }
    try {
      expect(await offline.identities.offlineData()[0]!.remove()).toBe(false)
    } finally {
      indexedDB.deleteDatabase = del
    }
    expect(await stored()).toBe(true)
    expect(offline.identities.offlineData().length > 0).toBe(true)
    expect(offSection()).toContain('Remove P2P data from this browser')
    expect(offline.identities.list()).toEqual([])
    expect(await offline.identities.offlineData()[0]!.remove()).toBe(true)
    expect(await stored()).toBe(false)
    expect(offline.identities.offlineData().length > 0).toBe(false)
  })

  test('without P2P data in this browser there is nothing to remove', () => {
    Object.assign(offline.store.getInitialState(), { me: me('carol'), settings: settings(false) })
    expect(offSection()).toBe('')
  })
})

describe('removing P2P data while P2P is on', () => {
  const db = () => peerStorage(home, 'bob').db!
  const stored = async () => (await indexedDB.databases()).some(d => d.name === db())

  test('a failed remove shows why and keeps P2P off until turned on', async () => {
    localStorage.setItem(
      peerStorage(home, 'bob').scoped(p2pKey('bob')),
      JSON.stringify({ v: 1, on: true })
    )
    ;(await openDB(db(), 1)).close()
    Object.assign(initial, { me: me('bob') })
    useP2p.setState({ account: 'bob', enabled: true })
    const del = indexedDB.deleteDatabase
    indexedDB.deleteDatabase = () => {
      throw new Error('denied')
    }
    try {
      expect(await p2p.removeData()).toBe(false)
    } finally {
      indexedDB.deleteDatabase = del
    }
    expect(await stored()).toBe(true)
    expect(p2p.hasData('bob')).toBe(false)
    p2pState(useP2p.getState())
    const failed = 'Couldn&#x27;t remove P2P data'
    const section = render(<P2pSection />)
    expect(section).toContain(failed)
    expect(section).toContain('Turn on P2P')
    expect(render(<P2pHome onMenu={() => {}} />)).toContain(failed)
    Object.assign(p2pInitial, p2pSaved)
    await p2pAccount('bob')
    expect(useP2p.getState().enabled).toBe(false)
    useP2p.setState({ error: "Couldn't remove P2P data" })
    // A lock that never comes: turning on starts no node here.
    Object.defineProperty(navigator, 'locks', {
      value: { request: () => new Promise(() => {}) },
      configurable: true,
    })
    try {
      await p2p.enable()
      expect(useP2p.getState().error).toBeNull()
      await p2pAccount(null)
    } finally {
      delete (navigator as { locks?: unknown }).locks
    }
    expect(await p2p.removeData('bob')).toBe(true)
    expect(await stored()).toBe(false)
  })
})

describe('personal filter on P2P names', () => {
  const stub = (t: string) => t.replace(/shit/gi, '****')
  const read = readText

  test('contacts, servers, channels, members and topics are masked when the filter is on', async () => {
    const c = contact(ALICE, 'Shitlord')
    const v = server({
      name: 'shit club',
      channels: [
        {
          id: CH,
          name: 'shit-talk',
          kind: 'text',
          pos: 0,
          topic: 'no shit topics',
          send: true,
          exempt: false,
          over: {},
        },
      ],
      members: [
        {
          ik: ALICE,
          m: 'join',
          name: 'Shitlord',
          owner: true,
          online: true,
          contact: true,
          below: false,
          waits: false,
          myInvite: false,
          unban: false,
          roles: [],
          top: null,
        },
      ],
    })
    Object.assign(initial, { me: me('bob') })
    p2pState({
      enabled: true,
      account: 'bob',
      me: BOB,
      contacts: [c],
      servers: { [SRV]: v },
      server: { room: SRV, ch: CH },
    })
    const plain = render(<P2pHome onMenu={() => {}} />) + render(<P2pServerSidebar />)
    expect(plain).toContain('Shitlord')
    expect(plain).toContain('shit club')
    expect(plain).toContain('shit-talk')

    await setMasking(true, () => Promise.resolve(stub))
    Object.assign(initial, { profanityReady: true })
    const html = read(
      render(<P2pHome onMenu={() => {}} />) +
        render(<P2pServerSidebar />) +
        render(<P2pMemberList />)
    )
    expect(html).toContain('****lord')
    expect(html).toContain('**** club')
    expect(html).toContain('****-talk')
    expect(/shit/i.test(html.replace(/data-p2p-(channel|member)="[^"]*"/g, ''))).toBe(false)
    // No em dashes in UI copy: the member group header counts in brackets.
    expect(html).not.toContain('\u2014')
  })

  test('the DM pane, chat rows, file tiles, rail tiles and the call banner are masked too', async () => {
    const att = { h: 'h1', size: 10, blocks: 1, name: 'shit list.txt', mime: 'text/plain' }
    const m: P2pMessage = {
      id: 'm1',
      sender: ALICE,
      ts: NOW,
      sentTs: NOW,
      sortKey: 'm1',
      seq: 1,
      body: 'hello there',
      reply: null,
      mentions: [],
      fwd: null,
      att: [att],
      edited: null,
      reactions: [],
      pinned: null,
      late: false,
      pending: false,
      failed: false,
      call: null,
    }
    Object.assign(initial, { me: me('bob') })
    p2pState({
      enabled: true,
      account: 'bob',
      me: BOB,
      name: 'Bob',
      status: 'online',
      home: true,
      contacts: [contact(ALICE, 'Shitlord')],
      rooms: {
        [ROOM]: { id: ROOM, peer: ALICE, seq: 1, unread: 0, pings: 0, lastTs: NOW },
      } as unknown as P2pState['rooms'],
      chat: {
        room: ROOM,
        peer: ALICE,
        messages: [m],
        more: false,
        loading: false,
        readSeq: 1,
        missed: [],
      },
      servers: { [SRV]: server({ name: 'shit club' }) },
      call: {
        id: 'c1',
        room: ROOM,
        peer: ALICE,
        dir: 'in',
        state: 'ringing',
        video: false,
        startedAt: NOW,
        since: null,
      },
    })
    const all = () =>
      render(<P2pDmPane onBack={() => {}} onMenu={() => {}} />) +
      render(<ServerRail />) +
      render(<CallBanner />)
    const plain = all()
    for (const t of ['Shitlord', 'shit list.txt', 'shit club']) expect(plain).toContain(t)

    await setMasking(true, () => Promise.resolve(stub))
    Object.assign(initial, { profanityReady: true })
    const html = read(all())
    expect(html).toContain('****lord')
    expect(html).toContain('**** list.txt')
    expect(html).toContain('**** club')
    const left = html.replace(/data-p2p-[a-z]+="[^"]*"/g, '')
    expect(left.match(/.{0,80}shit.{0,40}/gi)).toBe(null)
  })

  test('kick and ban labels and the channel delete tooltip are masked, but not in your server', async () => {
    const v = server({
      perms: 0xffff_ffff,
      owner: BOB,
      channels: [
        { id: CH, name: 'shit-talk', kind: 'text', pos: 0, send: true, exempt: false, over: {} },
        { id: 'c2', name: 'general', kind: 'text', pos: 1, send: true, exempt: false, over: {} },
      ],
    })
    const member = {
      ik: ALICE,
      m: 'join' as const,
      name: 'Shitlord',
      owner: false,
      online: true,
      contact: true,
      below: true,
      waits: false,
      myInvite: false,
      unban: false,
      roles: [],
      top: null,
    }
    p2pState({ enabled: true, account: 'bob', me: BOB, servers: { [SRV]: v } })
    await setMasking(true, () => Promise.resolve(stub))
    Object.assign(initial, { profanityReady: true, streamer: false })
    accountStore.setState({ profanityReady: true, streamer: false })
    const labels = memberMenu(v, member, peerOwner, peerApp).map(i => i.label)
    expect(labels).toContain('Kick ****lord')
    expect(labels).toContain('Ban ****lord')
    expect(render(<ServerSettingsDialog room={SRV} tab="channels" />)).toContain(
      'title="Delete #shit-talk"'
    )
    p2pState({
      enabled: true,
      account: 'bob',
      me: BOB,
      servers: { [SRV]: { ...v, owner: ALICE, owners: [ALICE] } },
    })
    const html = render(<ServerSettingsDialog room={SRV} tab="channels" />)
    expect(html).toContain('title="Delete #****-talk"')
  })
})

describe('forwarding', () => {
  const stub = (t: string) => t.replace(/shit/gi, '****')
  let list: ReturnType<typeof useP2pList> | null = null
  function Probe({ messages, draftKey = ROOM }: { messages: P2pMessage[]; draftKey?: string }) {
    list = useP2pList({
      messages,
      nameOf: ik => maskOf(accountStore.getState())(ik === ALICE ? 'Mom' : 'Carol'),
      ownName: ik => profileName(ik),
      people: [],
      draftKey,
      scope: `d:${draftKey}`,
      canAct: true,
      mayPin: false,
      mayDelete: () => false,
      forwardSkip: ALICE,
      threads: false,
    })
    return null
  }

  const message: P2pMessage = {
    id: 'm1',
    sender: ALICE,
    ts: NOW,
    sentTs: NOW,
    sortKey: 'm1',
    seq: 1,
    body: 'from alice',
    reply: null,
    mentions: [],
    fwd: null,
    att: [],
    edited: null,
    reactions: [],
    pinned: null,
    late: false,
    pending: false,
    failed: false,
    call: null,
  }

  test('copy and send use the source identity for colliding channels, threads and direct messages', async () => {
    const account = testAccount('bob', 'https://forward-owner.test')
    const other = testAccount('bob', 'https://forward-other.test')
    try {
      for (const owner of [account, other]) createPeerFixture(owner, 'bob')
      const main = account.identities.get()!
      const work = account.identities.add('work')
      const elsewhere = other.identities.add('work')
      for (const app of [main, work, elsewhere])
        app.useP2p.setState({ servers: { [SRV]: server() } })
      const target = work.peerTarget(work.useP2p.getState(), SRV, CH)!
      account.viewing.markPersonally(target, true)
      const copy = (app: typeof work, key: string) => {
        render(
          <AccountProvider session={account}>
            <P2pProvider identity={app}>
              <Probe messages={[message]} draftKey={key} />
            </P2pProvider>
          </AccountProvider>
        )
        const row = list!.rows[0]
        list!.copyRow(row.p, row.m)
      }
      const state = account.store.getState
      const sent: string[] = []
      account.store.setState({ sendThreadMessage: body => void sent.push(body) })
      copy(work, `${SRV}/${CH}#root`)
      expect(state().forwardClip).toBeNull()
      copy(main, `${SRV}/${CH}`)
      expect(state().forwardClip?.source).toEqual({ kind: 'p2p', room: SRV, ch: CH })
      account.viewing.markPersonally(target, false)
      copy(work, `${SRV}/${CH}#root`)
      const clip = parseForward(forwardValue(state().forwardClip))!
      expect(clip.source).toEqual({ kind: 'p2p', room: SRV, ch: CH, identity: 'work' })
      account.viewing.markPersonally(target, true)
      expect(state().forwardClip).toBeNull()
      account.store.setState({ forwardClip: clip })
      const bar = (owner: typeof account) => {
        Object.assign(owner.store.getInitialState(), { forwardClip: clip })
        return render(
          <AccountProvider session={owner}>
            <ForwardBar draftKey="t1" />
          </AccountProvider>
        )
      }
      expect(bar(account)).not.toContain(message.body)
      expect(bar(other)).toContain(message.body)
      state().sendForward('t1')
      expect(sent).toEqual([])
      account.viewing.markPersonally(target, false)
      state().sendForward('t1')
      expect(sent).toEqual([message.body])
      copy(main, ROOM)
      expect(state().forwardClip?.source).toEqual({ kind: 'direct' })
      copy(work, ROOM)
      expect(state().forwardClip?.source).toEqual({ kind: 'direct', identity: 'work' })
      const commands = peerChat.forIdentity(work)
      const wait = Promise.withResolvers<string>()
      const forwarded: string[] = []
      work.p2pDm.ensureRoom = () => wait.promise
      work.p2pDm.forward = async room => {
        forwarded.push(room)
        return true
      }
      const pending = commands.forwardTo(ALICE, message, 'Alice', account, ROOM)
      account.identities.unregister('work')
      expect(state().forwardClip).toBeNull()
      account.identities.add('work')
      wait.resolve(ROOM)
      await pending
      expect(forwarded).toEqual([])
      const row = list!.rows[0]
      commands.copyForP2p(message, row.m, 'Alice', ROOM, account)
      peerChat.forIdentity(elsewhere).copyForP2p(message, row.m, 'Alice', ROOM, account)
      expect(state().forwardClip).toBeNull()
    } finally {
      account.store.dispose()
      other.store.dispose()
    }
  })

  test('a forward carries the author’s own profile name, never a petname or a masked name', async () => {
    const m = message
    p2pState({
      enabled: true,
      account: 'bob',
      me: BOB,
      ik: BOB,
      name: 'Bob',
      contacts: [{ ...contact(ALICE, 'Shitlord'), petname: 'Mom' }, contact(CAROL, 'Carol')],
    })
    await setMasking(true, () => Promise.resolve(stub))
    Object.assign(initial, { profanityReady: true, me: me('bob') })
    accountStore.setState({ profanityReady: true, me: me('bob') })
    let items: ContextMenuItem[] = []
    const capture = (_x: number, _y: number, it: ContextMenuItem[]) => {
      items = it
    }
    Object.assign(initial, { openContextMenu: capture })
    accountStore.setState({ openContextMenu: capture })
    const sent: Fwd[] = []
    const saved = { ensureRoom: p2pDm.ensureRoom, forward: p2pDm.forward }
    p2pDm.ensureRoom = async () => 'carol-room'
    p2pDm.forward = async (_room: string, fwd: Fwd) => {
      sent.push(fwd)
      return true
    }
    const g = globalThis as { document?: unknown; Element?: unknown; HTMLElement?: unknown }
    const dom = { document: g.document, Element: g.Element, HTMLElement: g.HTMLElement }
    Object.assign(g, {
      document: { elementFromPoint: () => null },
      Element: class {},
      HTMLElement: class {},
    })
    try {
      render(<Probe messages={[m]} />)
      const row = list!.rows[0]
      // The row shows the petname, masked.
      expect(row.m.author.display_name).toBe('Mom')
      list!.rowMenu(row.p, row.m, 0, 0)
      const fwdItem = items.find(x => x.label === 'Forward')!
      await fwdItem.submenu!.find(x => x.label === 'Carol')!.action!()
      await new Promise(r => setTimeout(r, 0))
      expect(sent.map(f => f.name)).toEqual(['Shitlord'])
      // The forward clipboard carries the same name.
      fwdItem.submenu!.find(x => x.label === 'Copy for forwarding')!.action!()
      expect(accountStore.getState().forwardClip?.author?.display_name).toBe('Shitlord')
      list!.copyRow(row.p, row.m)
      expect(accountStore.getState().forwardClip?.author?.display_name).toBe('Shitlord')
    } finally {
      Object.assign(p2pDm, saved)
      Object.assign(g, dom)
    }
  })
})

describe('account chips', () => {
  test('a chip is a control the keyboard reaches', () => {
    p2pState({
      enabled: true,
      badges: { [ALICE]: { ik: ALICE, ok: null, todo: { token: 't', tried: 0 } } },
    })
    const html = render(<AccountChip ik={ALICE} />)
    expect(html).toContain('data-account-badge="unchecked"')
    expect(html).toContain('role="button"')
    expect(html).toContain('tabindex="0"')
    expect(html).toContain('aria-haspopup="menu"')
  })
})

describe('this device’s limits in server forms', () => {
  const maxOf = (html: string, placeholder: string) =>
    Number(
      new RegExp(`<input[^>]*maxLength="(\\d+)"[^>]*placeholder="${placeholder}"`).exec(html)?.[1]
    )

  test('an invite label and a channel topic take what this device shows, within one event', () => {
    p2pState({ enabled: true, account: 'bob', me: BOB, servers: { [SRV]: server({ perms: -1 }) } })
    const at = (display: Partial<Local['display']>) => {
      put.limits({ ...LOCAL, display: { ...LOCAL.display, ...display } })
      return [
        maxOf(render(<ServerInviteDialog room={SRV} />), 'For the book club'),
        maxOf(render(<ServerSettingsDialog room={SRV} tab="channels" />), 'Topic'),
      ]
    }
    try {
      expect(at({})).toEqual([64, 1024])
      expect(at({ label: 20, topic: 300 })).toEqual([20, 300])
      expect(at({ label: 1024, topic: 16 * 1024 })).toEqual([1024, 1024])
    } finally {
      put.limits(LOCAL)
    }
  })

  test('server and channel name fields take `server.nameMax`', () => {
    p2pState({ enabled: true, account: 'bob', me: BOB, servers: { [SRV]: server({ perms: -1 }) } })
    const named = (html: string, label: string) =>
      Number(new RegExp(`<input[^>]*maxLength="(\\d+)"[^>]*aria-label="${label}"`).exec(html)?.[1])
    const at = (nameMax: number) => {
      put.limits({ ...LOCAL, server: { ...LOCAL.server, nameMax } })
      const channels = render(<ServerSettingsDialog room={SRV} tab="channels" />)
      return [
        named(render(<ServerSettingsDialog room={SRV} tab="overview" />), 'Server name'),
        named(channels, 'Name of #general'),
        named(channels, 'New channel name'),
        named(render(<ServerNewDialog />), 'Server name'),
      ]
    }
    try {
      expect(at(LOCAL.server.nameMax)).toEqual([100, 100, 100, 100])
      expect(at(40)).toEqual([40, 40, 40, 40])
    } finally {
      put.limits(LOCAL)
    }
  })
})

describe('our own badge in other tabs', () => {
  test('the leading tab tells the others when our own badge changes, and only then', () => {
    const sent: unknown[] = []
    const post = (m: unknown) => void sent.push(m)
    const badge = { token: 't1', sub: 'alice', exp: 1, iat: 0 } as unknown as OwnBadge
    tellBadge(null, null, post)
    expect(sent).toEqual([])
    tellBadge(null, badge, post)
    tellBadge(badge, { ...badge }, post)
    tellBadge(badge, null, post)
    expect(sent).toEqual([{ badges: true }, { badges: true }])
  })

  test('mirroring the node posts badges when its badge changes, and only then', async () => {
    const sent: unknown[] = []
    const post = (m: unknown) => void sent.push(m)
    let badge: OwnBadge | null = null
    const n = {
      view: () => ({
        status: 'online' as const,
        ik: keyId(newKeyPair().pk),
        name: 'Alice',
        contacts: [],
        presence: {},
        dropped: 0,
        movedAt: null,
        movingAt: null,
        alertAt: null,
        badge,
      }),
      paused: false,
      myCard: async () => null,
    } as unknown as Parameters<typeof mirrorFrom>[0]
    useP2p.setState({ badge: null })
    await mirrorFrom(n, post)
    expect(sent).toEqual([])
    badge = { token: 't1', sub: 'alice', exp: 1, iat: 0 } as unknown as OwnBadge
    await mirrorFrom(n, post)
    await mirrorFrom(n, post)
    expect(sent).toEqual([{ badges: true }])
    expect(useP2p.getState().badge).toEqual(badge)
    badge = null
    await mirrorFrom(n, post)
    expect(sent).toEqual([{ badges: true }, { badges: true }])
  })
})

describe('P2P conversations in the DM list', () => {
  const DAVE = ik()
  const self: DmSummary = {
    id: 1,
    other: user('bob'),
    is_self: true,
    last_message_id: null,
    last_message_at: null,
    friend: false,
  }
  const inDms = () =>
    Object.assign(initial, {
      me: me('bob'),
      token: 'tok',
      view: { kind: 'dm', dmId: 1 },
      dms: [self],
      dmsMore: false,
    })
  const running = (over: Partial<P2pState> = {}) =>
    p2pState({
      enabled: true,
      account: 'bob',
      me: BOB,
      contacts: [
        contact(ALICE, 'Alice'),
        contact(CAROL, 'Carol'),
        contact(DAVE, 'Dave', 'incoming'),
      ],
      rooms: {
        [dmRoomId(BOB, CAROL)]: { id: 'r', peer: CAROL, seq: 1, unread: 1, pings: 2, lastTs: NOW },
      } as unknown as P2pState['rooms'],
      ...over,
    })
  const section = (html: string) => html.slice(html.indexOf('data-p2p-dms'))
  const order = (html: string) => [...html.matchAll(/data-contact="([^"]+)"/g)].map(m => m[1])

  test('the DM list shows the P2P conversations under their own divider, newest first', () => {
    inDms()
    running()
    const html = render(<ChannelSidebar />)
    expect(html).toContain('data-p2p-dms')
    expect(order(section(html))).toEqual([CAROL, ALICE])
    expect(section(html)).toContain('title="Add contact" aria-label="Add contact"')
    expect(section(html)).toContain('Message requests (1)')
  })

  test('no requests row without requests, and no P2P part until P2P runs', () => {
    inDms()
    running({ contacts: [contact(ALICE, 'Alice')] })
    expect(render(<ChannelSidebar />)).not.toContain('Message requests')
    running({ enabled: false })
    expect(render(<ChannelSidebar />)).not.toContain('data-p2p-dms')
    running({ account: null })
    expect(render(<ChannelSidebar />)).not.toContain('data-p2p-dms')
  })

  test('a P2P conversation open beside the list: its row is current, the DM tile is lit', () => {
    inDms()
    const chat = {
      room: dmRoomId(BOB, CAROL),
      peer: CAROL,
      messages: [],
      more: false,
      loading: false,
      readSeq: 0,
      missed: [],
    }
    running({ home: true, dmList: true, chat })
    const list = render(<ChannelSidebar />)
    expect(new RegExp(`data-contact="${CAROL}"[^>]*aria-current="true"`).test(list)).toBe(true)
    expect(/data-dm="1"[^>]*aria-current/.test(list)).toBe(false)
    const rail = render(<ServerRail />)
    expect(/<button[^>]*data-rail="dms"[^>]*bg-primary text-on-primary/.test(rail)).toBe(true)
    expect(/<button[^>]*aria-label="Peer-to-peer"[^>]*aria-pressed="false"/.test(rail)).toBe(true)
    const pane = render(<P2pDmPane onMenu={() => {}} />)
    expect(pane).not.toContain('Back to contacts')

    running({ home: true, dmList: false, chat })
    expect(
      /<button[^>]*aria-label="Peer-to-peer"[^>]*aria-pressed="true"/.test(render(<ServerRail />))
    ).toBe(true)
  })

  test('the instance DM row is current when no P2P conversation is beside the list', () => {
    inDms()
    running()
    expect(/data-dm="1"[^>]*aria-current="page"/.test(render(<ChannelSidebar />))).toBe(true)
  })

  test('the P2P home and closing it leave the place beside the DM list', () => {
    running({ home: true, dmList: true })
    p2p.openHome()
    expect(useP2p.getState()).toMatchObject({ home: true, dmList: false })
    running({ home: true, dmList: true })
    p2p.closeHome()
    expect(useP2p.getState()).toMatchObject({ home: false, dmList: false })
  })

  const carolChat = () => ({
    room: dmRoomId(BOB, CAROL),
    peer: CAROL,
    messages: [],
    more: false,
    loading: false,
    readSeq: 0,
    missed: [],
  })
  const requests = (html: string) => html.includes('aria-label="Message requests"')

  test('Message requests opens the requests, also with a conversation open', () => {
    for (const over of [
      { home: true, dmList: true, chat: carolChat() },
      { home: false, dmList: false, chat: carolChat() },
    ]) {
      running(over)
      p2p.openRequests()
      expect(useP2p.getState()).toMatchObject({ home: true, dmList: false, chat: null })
      p2pState(useP2p.getState())
      expect(requests(render(<P2pHome onMenu={() => {}} />))).toBe(true)
    }
  })

  test('closing a conversation beside the DM list closes the conversation', () => {
    running({ home: true, dmList: true, chat: carolChat() })
    p2p.closeHome()
    expect(useP2p.getState().chat).toBe(null)
    p2p.openHome()
    p2pState(useP2p.getState())
    expect(requests(render(<P2pHome onMenu={() => {}} />))).toBe(true)
    running({ home: true, dmList: false, chat: carolChat() })
    p2p.closeHome()
    expect(useP2p.getState().chat?.peer).toBe(CAROL)
  })

  test('the P2P home opened over a conversation beside the DM list shows the contacts', () => {
    const room = dmRoomId(BOB, CAROL)
    running({ home: true, dmList: true, chat: carolChat(), replying: { room, id: 'm1' } })
    p2p.openHome()
    expect(useP2p.getState()).toMatchObject({
      home: true,
      dmList: false,
      chat: null,
      pins: null,
      replying: null,
    })
    p2pState(useP2p.getState())
    expect(requests(render(<P2pHome onMenu={() => {}} />))).toBe(true)
    running({ home: false, dmList: false, chat: carolChat() })
    p2p.openHome()
    expect(useP2p.getState().chat?.peer).toBe(CAROL)
  })

  test('Add contact shows in the DM list exactly where the P2P home shows it', () => {
    const add = 'title="Add contact" aria-label="Add contact"'
    const STATES: [string, Partial<P2pState>, boolean][] = [
      ['running', {}, true],
      ['starting', { loading: true }, false],
      ['open in another tab', { elsewhere: true }, false],
      ['reading here, open in another tab', { elsewhere: true, reader: true }, false],
      ['reading here with no contacts yet', { elsewhere: true, reader: true, contacts: [] }, false],
      ['with no contacts yet', { contacts: [] }, true],
    ]
    for (const [state, over, shown] of STATES) {
      inDms()
      running(over)
      const list = section(render(<ChannelSidebar />)).includes(add)
      const home = render(<P2pHome onMenu={() => {}} />).includes('Add contact')
      expect([state, list, home]).toEqual([state, shown, shown])
    }
  })
})

describe('a tab that only reads', () => {
  test('delayed room reads cannot reopen Alice’s conversation on Bob’s home app', async () => {
    const alice = await P2pStore.open(crypto.randomUUID())
    const room = blankRoom(dmRoomId(ALICE, CAROL), CAROL, NOW)
    const delayed = Promise.withResolvers<RoomRecord>()
    const aliceOwner = new AccountSession(home)
    const aliceApp = createPeerFixture(aliceOwner, 'alice')
    alice.room = () => delayed.promise
    alice.rooms = async () => [await delayed.promise]
    try {
      expect(aliceApp.useP2p.getState().account).toBe('alice')
      aliceApp.put.reader({ store: alice, me: ALICE })
      const reads = [
        aliceApp.refreshRooms(),
        aliceApp.refreshRoom(room.id),
        aliceApp.p2pDm.openDm(CAROL),
      ]
      aliceOwner.identities.setAccount(null)
      await p2pAccount('bob')
      const bob = useP2p.getState()
      delayed.resolve(room)
      await Promise.all(reads)
      expect(useP2p.getState()).toBe(bob)
      expect(bob.account).toBe('bob')
    } finally {
      await p2pAccount(null)
      aliceOwner.store.dispose()
      alice.close()
    }
  })

  test('a send that fails keeps what it replied to; Mark all as read says where it can be done', async () => {
    p2pState({
      enabled: true,
      reader: true,
      elsewhere: true,
      me: BOB,
      replying: { room: ROOM, id: 'm1' },
      rooms: {
        [ROOM]: { id: ROOM, peer: ALICE, seq: 2, unread: 1, pings: 1, lastTs: NOW },
      } as unknown as P2pState['rooms'],
      servers: {
        [SRV]: server({ chans: { [CH]: { unread: 1, pings: 0, readSeq: 0 } } }),
      } as unknown as P2pState['servers'],
    })
    const toasts: string[] = []
    const was = p2pHost.toast
    p2pHost.toast = text => toasts.push(text)
    try {
      expect(await p2pDm.send(ROOM, 'hello')).toBe(false)
      expect(useP2p.getState().replying).toEqual({ room: ROOM, id: 'm1' })
      toasts.length = 0
      p2pDm.markAllRead()
      p2pServer.markAllRead(SRV)
      expect(toasts).toEqual(['P2P is open in another tab.', 'P2P is open in another tab.'])
    } finally {
      p2pHost.toast = was
    }
  })
})

describe('P2P inbox in the app', () => {
  test('the bell counts P2P pings that badge and that the list can show', () => {
    const LEFT = 'left-room'
    const st = {
      ...p2pSaved,
      rooms: {
        [ROOM]: { id: ROOM, peer: ALICE, unread: 2, pings: 2, lastTs: 0 },
        old: { id: 'old', peer: CAROL, unread: 1, pings: 4, lastTs: 0 },
      },
      servers: {
        [SRV]: server({ chans: { [CH]: { unread: 1, pings: 3, readSeq: 0 } } }),
        [LEFT]: server({
          id: LEFT,
          me: 'leave',
          chans: { [CH]: { unread: 0, pings: 2, readSeq: 0 } },
        }),
      },
    } as unknown as P2pState
    // Listable: both DM pings, one channel ping (the others are by a blocked member or on deleted
    // messages); nothing from before the log ('old') or from the server left.
    const listed = new Map([
      [ROOM, 2],
      [`${SRV}/${CH}`, 1],
    ])
    expect(p2pPingCount(st, EMPTY_NOTIFY, listed)).toBe(3)
    expect(
      p2pPingCount(st, setLevel(EMPTY_NOTIFY, { kind: 'p2p', room: ROOM }, 'nothing'), listed)
    ).toBe(1)
    // Never more than the counter: rows just marked or read wait for the next count.
    expect(p2pPingCount(st, EMPTY_NOTIFY, new Map([[ROOM, 9]]))).toBe(2)
    expect(p2pPingCount(st, EMPTY_NOTIFY, new Map())).toBe(0)
    Object.assign(initial, { me: me('bob') })
    addInboxAdapter({ ...createP2pInbox(peerOwner, peerApp), id: 'counted', count: () => 4 })
    try {
      expect(render(<InboxButton />)).toContain('title="Inbox, 4 notifications"')
    } finally {
      removeInboxAdapter('counted')
    }
  })

  test('a thread ping counts in the bell like a channel ping', () => {
    const st = {
      ...p2pSaved,
      rooms: {},
      servers: {
        [SRV]: server({ chans: { [CH]: { unread: 0, pings: 2, readSeq: 0, threads: { r1: 1 } } } }),
      },
    } as unknown as P2pState
    const listed = byCounter([
      ping('a', { room: SRV, ch: CH }),
      ping('b', { room: SRV, ch: CH, thread: 'r1' }),
    ])
    expect([...listed]).toEqual([[`${SRV}/${CH}`, 2]])
    expect(p2pPingCount(st, EMPTY_NOTIFY, listed)).toBe(2)
  })

  test('the world reflects contacts, blocks and servers', () => {
    const st = {
      ...p2pSaved,
      rooms: { [ROOM]: { id: ROOM, peer: ALICE, unread: 0, pings: 0 } },
      contacts: [contact(ALICE, 'Alice'), contact(CAROL, 'Carol', 'blocked')],
      servers: { [SRV]: server() },
    } as unknown as P2pState
    const w = worldOf(st, new Map())
    expect(w.dms.get(ROOM)).toBe(ALICE)
    expect([...w.blocked]).toEqual([CAROL])
    expect(pingVisible(ping('a'), w)).toBe(true)
    expect(pingVisible(ping('c', { actor: CAROL, room: SRV, ch: CH }), w)).toBe(false)
  })

  test('the listed pings are counted again on stored changes, never on typing or presence', () => {
    const base = {
      ...p2pSaved,
      enabled: true,
      me: BOB,
      rooms: { [ROOM]: { id: ROOM, peer: ALICE, seq: 4, unread: 1, pings: 1 } },
      servers: { [SRV]: server({ seq: 9, chans: { [CH]: { unread: 0, pings: 1, readSeq: 2 } } }) },
      contacts: [contact(ALICE, 'Alice')],
    } as unknown as P2pState
    const v = base.servers[SRV]
    const typing = { ...base, servers: { [SRV]: { ...v, online: 3 } }, rooms: { ...base.rooms } }
    expect(pingInputsChanged(typing, base)).toBe(false)
    const changed: Partial<P2pState>[] = [
      { servers: { [SRV]: { ...v, seq: 10 } } },
      { servers: { [SRV]: { ...v, chans: { [CH]: { unread: 0, pings: 0, readSeq: 9 } } } } },
      { servers: { [SRV]: { ...v, me: 'leave' } } },
      { rooms: { [ROOM]: { ...base.rooms[ROOM], seq: 5 } } },
      { contacts: [contact(ALICE, 'Alice', 'blocked')] },
      { pingLog: 1 },
    ]
    for (const over of changed) expect(pingInputsChanged({ ...base, ...over }, base)).toBe(true)
  })

  test('Jump to present leaves a window opened at a message before anything loads', () => {
    p2pState({
      enabled: true,
      me: BOB,
      chat: {
        room: ROOM,
        peer: ALICE,
        messages: [],
        more: false,
        newer: true,
        loading: false,
        readSeq: 0,
        missed: [],
      },
    })
    // A refresh starting now loads the newest page, not the window again.
    void p2pDm.toPresent()
    expect(useP2p.getState().chat?.newer).toBe(false)
  })

  test('every "Mark all as read" includes P2P, through the one confirm', () => {
    p2pState({
      enabled: true,
      me: BOB,
      contacts: [contact(ALICE, 'Alice', 'mutual')],
      rooms: {
        [ROOM]: { id: ROOM, peer: ALICE, seq: 4, unread: 1, pings: 0 },
      } as unknown as P2pState['rooms'],
    })
    accountStore.setState({ me: me('bob'), confirm: null })
    expect(p2pMarkAll().pending).toBe(true)
    expect(markAllReadItem(peerOwner).disabled).toBe(false)
    let marked = 0
    accountStore.getState().askMarkAllRead({ pending: true, mark: () => (marked += 1) })
    const asked = accountStore.getState().confirm
    expect(asked?.body).toBe('Mark every channel and DM as read?')
    asked?.action('')
    expect(marked).toBe(1)
    accountStore.setState({ confirm: null })
    accountStore.getState().askMarkAllRead({ pending: false, mark: () => (marked += 1) })
    expect(accountStore.getState().confirm).toBe(null)
    p2pState({ enabled: true, me: BOB })
    expect(p2pMarkAll().pending).toBe(false)
    expect(markAllReadItem(peerOwner).disabled).toBe(true)
  })

  test('without P2P the source lists nothing', async () => {
    p2pState({ enabled: false })
    expect(await createP2pInbox(peerOwner, peerApp).load(DEFAULT_VIEW, null)).toEqual({
      entries: [],
      next: null,
    })
  })
})

describe('P2P in the palette index', () => {
  const msg = (id: string, body: string, over: Partial<P2pMessage> = {}): P2pMessage => ({
    id,
    sender: ALICE,
    ts: NOW,
    sentTs: NOW,
    sortKey: id,
    seq: 1,
    body,
    reply: null,
    mentions: [],
    fwd: null,
    att: [],
    edited: null,
    reactions: [],
    pinned: null,
    late: false,
    pending: false,
    failed: false,
    call: null,
    ...over,
  })

  test('two identities index, count and open coincident messages independently', async () => {
    Object.assign(globalThis, { localStorage: memoryStorage })
    memoryStorage.setItem('rchat_palette:bob', JSON.stringify({ v: 1, used: {}, index: 'loaded' }))
    accountStore.setState({ me: me('bob') })
    __sync.switchOwner('bob', false)
    const account = peerOwner
    const bind = (id: string) => {
      const app = createP2pApp(account, id)
      app.useP2p.setState({
        enabled: true,
        me: BOB,
        rooms: {
          [ROOM]: {
            id: ROOM,
            peer: ALICE,
            seq: 10,
            unread: 1,
            pings: 1,
            lastTs: NOW,
            count: 1,
            bytes: 10,
            full: false,
            fullWhy: undefined,
            peerFull: false,
            gap: false,
          },
        },
        contacts: [contact(ALICE, id)],
        chat: {
          room: ROOM,
          peer: ALICE,
          messages: [msg('same', id)],
          readSeq: 0,
          more: false,
          loading: false,
          missed: [],
        },
      })
      const opened: string[] = []
      const marked: string[] = []
      app.p2pOpenAt = async (_room, _ch, message) => {
        opened.push(message)
      }
      app.p2pPings.read = async () => ({ list: [ping('same')], readSeq: new Map() })
      app.p2pPings.text = async () => ({ content: id, media: null, mediaSpoiler: false })
      app.p2pPings.alive = async () => true
      app.p2pPings.mark = async ids => {
        marked.push(...ids)
      }
      const inbox = createP2pInbox(account, app)
      const stopPings = startP2pPings(account, app)
      const stopIndex = startP2pIndex(account, { app })
      return { app, inbox, opened, marked, stopPings, stopIndex }
    }
    // A Full index written by the single-identity client already contains this message.
    const historical = p2pDoc(ROOM, null, msg('same', 'old text'), 'Alice')!
    indexDocs([historical])
    const a = bind('main')
    const b = bind('second')
    try {
      const [first, second] = await Promise.all(
        [a, b].map(async x => (await x.inbox.load(DEFAULT_VIEW, null)).entries[0])
      )
      expect(first.content).toBe('main')
      expect(second.content).toBe('second')
      expect(first.adapter).not.toBe(second.adapter)
      expect(first.key).not.toBe(second.key)
      expect(a.inbox.count!()).toBe(1)
      expect(b.inbox.count!()).toBe(1)
      const docs = (app: typeof a.app) => paletteIndex()!.docsIn(p2pBucket(ROOM, null, app))
      const [da] = docs(a.app)
      const [db] = docs(b.app)
      expect(da).toMatchObject({ id: 'psame', source: 'p2p', bucket: `p:${ROOM}` })
      expect(paletteIndex()!.docsIn(historical.bucket)).toEqual([da])
      expect(da.id).not.toBe(db.id)
      expect(da.source).not.toBe(db.source)
      expect(da.bucket).not.toBe(db.bucket)
      expect(da.text).toBe('main')
      expect(db.text).toBe('second')
      account.indexer.indexSource(db.source)!.open(db)
      await b.inbox.open(second)
      await a.inbox.markRead(first)
      expect(b.opened).toEqual(['same', 'same'])
      expect(a.opened).toEqual([])
      expect(a.marked).toEqual(['same'])
      expect(b.marked).toEqual([])
      // An old registration can outlive its username while the account and app are reused.
      let live = true
      const old = createP2pInbox(account, a.app, () => live)
      const pending = old.load(DEFAULT_VIEW, null)
      const pendingMark = old.markAll(DEFAULT_VIEW, [first])
      live = false
      expect(await pending).toEqual({ entries: [], next: null })
      await pendingMark
      await old.markRead(first)
      await old.open(first)
      expect(old.canPreview!(first)).toBe(false)
      expect(old.count!()).toBe(0)
      expect(a.opened).toEqual([])
      expect(a.marked).toEqual(['same'])
      expect(a.inbox.count!()).toBe(1)
      a.stopPings()
      b.stopIndex()
      expect(a.inbox.count!()).toBe(0)
      expect(b.inbox.count!()).toBe(1)
      expect(account.indexer.indexSource(db.source)).toBeUndefined()
      expect(account.indexer.indexSource(da.source)).not.toBeUndefined()
      expect(docs(b.app)).toEqual([])
      expect(docs(a.app)).toEqual([da])
      a.stopIndex()
      expect(docs(a.app)).toEqual([])
    } finally {
      a.stopPings()
      a.stopIndex()
      b.stopPings()
      b.stopIndex()
      a.app.dispose()
      b.app.dispose()
      __sync.switchOwner(null, false)
      memoryStorage.clear()
    }
  })

  test('documents name no instance server and keep spoilers out', () => {
    expect(p2pBucket(ROOM, null)).toBe(`p:${ROOM}`)
    expect(bucketPlace(p2pBucket(SRV, CH))).toEqual({ room: SRV, ch: CH })
    expect(bucketPlace('c12')).toBe(null)
    const d = p2pDoc(SRV, CH, msg('e1', 'the answer is ||42||'), 'Alice')!
    expect(d).toMatchObject({
      id: 'pe1',
      source: 'p2p',
      bucket: `p:${SRV}/${CH}`,
      server: null,
      channel: null,
      dm: null,
      msg: null,
      author: ALICE,
      name: 'Alice',
      at: Math.floor(NOW / 1000),
    })
    expect(d.text.includes('42')).toBe(false)
    expect(p2pDoc(ROOM, null, msg('e2', '   '), 'Alice')).toBe(null)
    expect(
      p2pDoc(ROOM, null, msg('e3', 'x', { system: { kind: 'join', ik: ALICE } }), 'Alice')
    ).toBe(null)
    expect(
      p2pDoc(ROOM, null, msg('e4', '', { fwd: { name: 'Zed', ts: 1, body: 'forwarded' } }), 'A')
        ?.text
    ).toBe('forwarded')
  })

  test('documents show only while the conversation or channel is open to the user', () => {
    const base = {
      ...p2pSaved,
      enabled: true,
      rooms: { [ROOM]: { id: ROOM, peer: ALICE, unread: 0, pings: 0 } },
      contacts: [contact(ALICE, 'Alice'), contact(CAROL, 'Carol')],
      servers: { [SRV]: server() },
    } as unknown as P2pState
    const dmDoc = p2pDoc(ROOM, null, msg('d', 'hello'), 'Alice')!
    const chDoc = p2pDoc(SRV, CH, msg('c', 'hello', { sender: CAROL }), 'Carol')!
    expect(p2pDocVisible(base, dmDoc, peerApp)).toBe(true)
    expect(p2pDocVisible(base, chDoc, peerApp)).toBe(true)
    expect(p2pDocVisible({ ...base, enabled: false }, dmDoc, peerApp)).toBe(false)
    const blockedAlice = { ...base, contacts: [contact(ALICE, 'Alice', 'blocked')] }
    expect(p2pDocVisible(blockedAlice, dmDoc, peerApp)).toBe(false)
    expect(p2pDocVisible({ ...base, contacts: [] }, dmDoc, peerApp)).toBe(false)
    const blockedCarol = { ...base, contacts: [contact(CAROL, 'Carol', 'blocked')] }
    expect(p2pDocVisible(blockedCarol, chDoc, peerApp)).toBe(false)
    for (const m of ['leave', 'ban'] as const)
      expect(
        p2pDocVisible({ ...base, servers: { [SRV]: server({ me: m }) } }, chDoc, peerApp)
      ).toBe(false)
    expect(
      p2pDocVisible({ ...base, servers: { [SRV]: server({ channels: [] }) } }, chDoc, peerApp)
    ).toBe(false)
    expect(p2pDocVisible({ ...base, servers: {} }, chDoc, peerApp)).toBe(false)
    expect(p2pDocPlace(base, dmDoc, peerApp)).toBe('P2P direct message')
    expect(p2pDocPlace(base, chDoc, peerApp)).toBe('#general · Book club')
    expect(placesOf(base)).toEqual([
      { room: ROOM, ch: null },
      { room: SRV, ch: CH },
    ])
  })

  test('only stored changes refresh a place, and a refresh drops only in its own bucket', async () => {
    Object.assign(globalThis, { localStorage: memoryStorage })
    memoryStorage.setItem('rchat_palette:bob', JSON.stringify({ v: 1, used: {}, index: 'loaded' }))
    accountStore.setState({ me: me('bob') })
    __sync.switchOwner('bob', false)
    const CH2 = 'chan2'
    const v = server({
      channels: [
        { id: CH, name: 'general', kind: 'text', pos: 0, send: true, exempt: false, over: {} },
        { id: CH2, name: 'random', kind: 'text', pos: 1, send: true, exempt: false, over: {} },
      ],
      seq: 7,
    })
    const rooms = {
      [ROOM]: { id: ROOM, peer: ALICE, unread: 0, pings: 0, seq: 3 },
    } as unknown as P2pState['rooms']
    p2pState({
      enabled: true,
      account: 'bob',
      me: BOB,
      contacts: [contact(ALICE, 'Alice')],
      rooms,
      servers: { [SRV]: v },
    })
    const ix = paletteIndex()!
    let scans = 0
    const realDrop = ix.dropWhere.bind(ix)
    ix.dropWhere = pred => {
      scans += 1
      return realDrop(pred)
    }
    indexDocs([
      p2pDoc(SRV, CH, msg('pa', 'kept words'), 'Alice')!,
      p2pDoc(SRV, CH, msg('pb', 'deleted words'), 'Alice')!,
      p2pDoc(SRV, CH2, msg('pc', 'random words'), 'Alice')!,
      p2pDoc(ROOM, null, msg('pd', 'private words'), 'Alice')!,
    ])
    const read: string[] = []
    const stop = startP2pIndex(peerOwner, {
      app: peerApp,
      recent: async (room: string, ch: string | null) => {
        read.push(p2pBucket(room, ch))
        return ch === CH ? [msg('pa', 'kept words')] : []
      },
      refreshMs: 5,
    })
    const until = async (ok: () => boolean) => {
      for (let i = 0; i < 100 && !ok(); i++) await new Promise(r => setTimeout(r, 10))
    }
    try {
      // Typing and presence rebuild the views without storing anything.
      useP2p.setState({ servers: { [SRV]: { ...v, online: 1 } }, rooms: { ...rooms } })
      await new Promise(r => setTimeout(r, 60))
      expect(read).toEqual([])
      useP2p.setState({ servers: { [SRV]: { ...v, seq: 8 } } })
      await until(() => read.length >= 2)
      expect(read.sort()).toEqual([p2pBucket(SRV, CH), p2pBucket(SRV, CH2)])
      const ids = (b: string) => ix.docsIn(b).map(d => d.id)
      expect(ids(p2pBucket(SRV, CH))).toEqual(['ppa'])
      expect(ids(p2pBucket(SRV, CH2))).toEqual(['ppc'])
      expect(ids(p2pBucket(ROOM, null))).toEqual(['ppd'])
      expect(scans).toBe(0)
      // A removed contact: the conversation with them goes, like a blocked person's messages.
      useP2p.setState({ contacts: [] })
      expect(ids(p2pBucket(ROOM, null))).toEqual([])
      expect(ids(p2pBucket(SRV, CH))).toEqual(['ppa'])
    } finally {
      stop()
      __sync.switchOwner(null, false)
      memoryStorage.clear()
    }
  })

  test('the palette finds a P2P message, shows its place and opens it through P2P', () => {
    const off = registerIndexSource(createIndexSource(peerApp))
    try {
      p2pState({
        enabled: true,
        rooms: { [ROOM]: { id: ROOM, peer: ALICE, unread: 0, pings: 0 } } as never,
        contacts: [contact(ALICE, 'Alice')],
      })
      const index = new PaletteIndex(1_000_000)
      index.add([p2pDoc(ROOM, null, msg('e9', 'pineapple pizza tonight'), 'Alice')!])
      const ctx = {
        index,
        visible: (d: Parameters<typeof p2pDocVisible>[1]) =>
          p2pDocVisible(useP2p.getState(), d, peerApp),
        mask: (t: string) => t,
      } as unknown as ResultCtx
      const s = { ...accountStore.getState(), streamer: false }
      const [hit] = messageItems(s, ctx, 'pineapple', 5, peerOwner)
      expect(hit.item.title).toContain('pineapple pizza tonight')
      expect(hit.item.subtitle).toContain('Alice')
      expect(hit.item.subtitle).toContain('P2P direct message')
      p2pState({ enabled: true, contacts: [contact(ALICE, 'Alice', 'blocked')] })
      expect(messageItems(s, ctx, 'pineapple', 5, peerOwner)).toEqual([])
    } finally {
      off()
    }
  })
})

describe('P2P on Home', () => {
  test('P2P visits are kept, read back defensively and shown only while open', () => {
    let prefs = parseHome(null)
    prefs = pushP2pRecent(prefs, ROOM, null, 1)
    prefs = pushP2pRecent(prefs, SRV, CH, 2)
    prefs = pushP2pRecent(prefs, ROOM, null, 3)
    expect(prefs.recents.map(recentKey)).toEqual([`p${ROOM}`, `p${SRV}/${CH}`])
    const back = parseHome(
      JSON.stringify({
        ...prefs,
        recents: [
          ...prefs.recents,
          { kind: 'p2p', room: 'a/b', ch: null, at: 1 },
          { kind: 'p2p', room: '', ch: null, at: 1 },
          { kind: 'p2p', room: 'x', ch: 5, at: 1 },
        ],
      })
    )
    expect(back.recents).toEqual(prefs.recents)
    const at = {
      servers: new Set<string>(),
      serversMore: false,
      dmIds: new Set<number>(),
      channels: {},
      p2p: new Set([`p${ROOM}`]),
    }
    expect(recentShown(prefs.recents[0], at)).toBe(true)
    expect(recentShown(prefs.recents[1], at)).toBe(false)
    expect(recentShown(prefs.recents[0], { ...at, p2p: undefined })).toBe(false)
  })

  test('Unread lists joined P2P servers with pings or unread channels, and P2P DMs', () => {
    const servers = {
      a: server({ id: 'a', name: 'Quiet', chans: { [CH]: { unread: 0, pings: 0, readSeq: 0 } } }),
      b: server({ id: 'b', name: 'Busy', chans: { [CH]: { unread: 4, pings: 0, readSeq: 0 } } }),
      c: server({ id: 'c', name: 'Pinged', chans: { [CH]: { unread: 1, pings: 2, readSeq: 0 } } }),
      d: server({
        id: 'd',
        name: 'Left',
        me: 'leave',
        chans: { [CH]: { unread: 9, pings: 9, readSeq: 0 } },
      }),
    }
    const bob = keyId(newKeyPair().pk)
    const gone = keyId(newKeyPair().pk)
    const contactOf = (ik: string, state: Contact['state']) =>
      ({ ik, state, ignored: false, name: ik, petname: null }) as unknown as Contact
    const rooms = {
      [ROOM]: { id: ROOM, peer: bob, unread: 1, pings: 0 },
      // A contact who was blocked, or removed: no row, so nothing counts.
      blocked: { id: 'blocked', peer: gone, unread: 3, pings: 2 },
    }
    const contacts = [contactOf(bob, 'mutual'), contactOf(gone, 'blocked')]
    const out = p2pUnread({ servers, rooms, contacts }, EMPTY_NOTIFY, NOW)
    expect(out.servers.map(r => [r.v.name, r.pings, r.channels])).toEqual([
      ['Pinged', 2, 1],
      ['Busy', 0, 1],
    ])
    expect(out.dms).toEqual({ pings: 0, unread: true })
    const only = { blocked: rooms.blocked }
    expect(p2pUnread({ servers, rooms: only, contacts }, EMPTY_NOTIFY, NOW).dms).toEqual({
      pings: 0,
      unread: false,
    })
    const muted = setLevel(EMPTY_NOTIFY, { kind: 'p2pc', room: 'c', ch: CH }, 'nothing')
    expect(
      p2pUnread({ servers, rooms, contacts }, muted, NOW).servers.map(r => [r.v.name, r.pings])
    ).toEqual([
      ['Busy', 0],
      ['Pinged', 0],
    ])
  })
})

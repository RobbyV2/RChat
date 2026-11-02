import { afterAll, afterEach, describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import type { ReactElement } from 'react'
import { AppRouterContext } from 'next/dist/shared/lib/app-router-context.shared-runtime'
import type { AppRouterInstance } from 'next/dist/shared/lib/app-router-context.shared-runtime'
import { resetSessionCaches, useStore } from '../store'
import { resetMasking, setMasking } from '../profanity'
import { DEFAULT_VIEW, type InboxView } from '../inbox'
import { addInboxAdapter, removeInboxAdapter } from '../inbox_source'
import { EMPTY_NOTIFY, setLevel } from '../notify'
import { parseHome, pushP2pRecent, recentKey, recentShown } from '../home'
import { messageItems, type ResultCtx } from '../palette_results'
import { PaletteIndex } from '../palette_index'
import { useP2p, type P2pState } from '../p2p/app'
import type { Contact } from '../p2p/contacts'
import { keyId, newKeyPair } from '../p2p/keys'
import type { RoomRecord } from '../p2p/db'
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
  PINGS_KEPT,
  PING_KEEP_MS,
  P2P_DM_LABEL,
  type PingRec,
  type PingWorld,
} from '../p2p/inbox'
import {
  listedIn,
  pingInputsChanged,
  pingNotifies,
  p2pInbox,
  p2pPingCount,
  worldOf,
} from '../p2p/inbox_source'
import {
  bucketPlace,
  p2pBucket,
  p2pDoc,
  p2pDocPlace,
  p2pDocVisible,
  p2pIndexSource,
  placesOf,
} from '../p2p/palette_source'
import { __sync, indexDocs, paletteIndex, registerIndexSource } from '../palette_sync'
import { startP2pIndex } from '../p2p/palette_source'
import { ServerRail } from '../../components/server_rail'
import { InboxButton } from '../../components/inbox'
import { P2pHome } from '../../components/p2p/p2p_home'
import { memberMenu, P2pMemberList, P2pServerSidebar } from '../../components/p2p/p2p_server_view'
import { P2pDmPane } from '../../components/p2p/p2p_dm_pane'
import { ServerSettingsDialog } from '../../components/p2p/p2p_server_settings'
import { CallBanner } from '../../components/voice_grid'
import { markAllReadItem } from '../../components/mark_read'
import { p2pMarkAll } from '../p2p/app'
import { me, memoryStorage } from './fixtures'

afterAll(resetSessionCaches)

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
  perms: 0,
  history: 'shared',
  system: { ch: CH, join: true, leave: true },
  channels: [{ id: CH, name: 'general', kind: 'text', pos: 0 }],
  members: [],
  online: 0,
  joined: 2,
  chans: {},
  seq: 0,
  gap: false,
  full: false,
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

    const old = ping('old', { at: NOW - PING_KEEP_MS - 1 })
    const added = addPings(
      [old, ping('a')],
      [ping('a', { seq: 50 }), ping('n', { at: NOW + 5 })],
      NOW
    )
    expect(added.map(p => p.id)).toEqual(['n', 'a'])
    expect(added[1].seq).toBe(10)
    const many = Array.from({ length: PINGS_KEPT + 20 }, (_, i) => ping(`p${i}`, { at: NOW + i }))
    const capped = addPings([], many, NOW)
    expect(capped.length).toBe(PINGS_KEPT)
    expect(capped[0].id).toBe(`p${PINGS_KEPT + 19}`)
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

  test('only places still open show: blocked people, left servers and gone channels drop out', () => {
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
const initial = useStore.getInitialState()
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
  renderToStaticMarkup(<AppRouterContext.Provider value={router}>{node}</AppRouterContext.Provider>)

const p2pState = (over: Partial<P2pState>) => {
  Object.assign(p2pInitial, p2pSaved, over)
  useP2p.setState(p2pInitial)
}

afterEach(() => {
  Object.assign(initial, saved)
  Object.assign(p2pInitial, p2pSaved)
  useP2p.setState(p2pSaved)
  useStore.setState(saved)
  resetMasking()
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
})

describe('personal filter on P2P names', () => {
  const stub = (t: string) => t.replace(/shit/gi, '****')

  test('contacts, servers, channels, members and topics are masked when the filter is on', async () => {
    const c = contact(ALICE, 'Shitlord')
    const v = server({
      name: 'shit club',
      channels: [{ id: CH, name: 'shit-talk', kind: 'text', pos: 0, topic: 'no shit topics' }],
      members: [
        { ik: ALICE, m: 'join', name: 'Shitlord', owner: true, online: true, contact: true },
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
    const html =
      render(<P2pHome onMenu={() => {}} />) +
      render(<P2pServerSidebar />) +
      render(<P2pMemberList />)
    expect(html).toContain('****lord')
    expect(html).toContain('**** club')
    expect(html).toContain('****-talk')
    expect(/shit/i.test(html.replace(/data-p2p-(channel|member)="[^"]*"/g, ''))).toBe(false)
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
    const html = all()
    expect(html).toContain('****lord')
    expect(html).toContain('**** list.txt')
    expect(html).toContain('**** club')
    const left = html.replace(/data-p2p-[a-z]+="[^"]*"/g, '')
    expect(left.match(/.{0,80}shit.{0,40}/gi)).toBe(null)
  })

  test('kick and ban labels and the channel delete tooltip are masked', async () => {
    const v = server({
      perms: 0xffff_ffff,
      owner: BOB,
      channels: [
        { id: CH, name: 'shit-talk', kind: 'text', pos: 0 },
        { id: 'c2', name: 'general', kind: 'text', pos: 1 },
      ],
    })
    const member = {
      ik: ALICE,
      m: 'join' as const,
      name: 'Shitlord',
      owner: false,
      online: true,
      contact: true,
    }
    p2pState({ enabled: true, account: 'bob', me: BOB, servers: { [SRV]: v } })
    await setMasking(true, () => Promise.resolve(stub))
    Object.assign(initial, { profanityReady: true })
    useStore.setState({ profanityReady: true })
    const labels = memberMenu(v, member).map(i => i.label)
    expect(labels).toContain('Kick ****lord')
    expect(labels).toContain('Ban ****lord')
    const html = render(<ServerSettingsDialog room={SRV} tab="channels" />)
    expect(html).toContain('title="Delete #****-talk"')
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
    addInboxAdapter({ ...p2pInbox, id: 'counted', count: () => 4 })
    try {
      expect(render(<InboxButton />)).toContain('title="Inbox, 4 notifications"')
    } finally {
      removeInboxAdapter('counted')
    }
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

  test('every "Mark all as read" includes P2P, through the one confirm', () => {
    p2pState({
      enabled: true,
      me: BOB,
      rooms: {
        [ROOM]: { id: ROOM, peer: ALICE, seq: 4, unread: 1, pings: 0 },
      } as unknown as P2pState['rooms'],
    })
    useStore.setState({ me: me('bob'), confirm: null })
    expect(p2pMarkAll().pending).toBe(true)
    expect(markAllReadItem().disabled).toBe(false)
    let marked = 0
    useStore.getState().askMarkAllRead({ pending: true, mark: () => (marked += 1) })
    const asked = useStore.getState().confirm
    expect(asked?.body).toBe('Mark every channel and DM as read?')
    asked?.action('')
    expect(marked).toBe(1)
    useStore.setState({ confirm: null })
    useStore.getState().askMarkAllRead({ pending: false, mark: () => (marked += 1) })
    expect(useStore.getState().confirm).toBe(null)
    p2pState({ enabled: true, me: BOB })
    expect(p2pMarkAll().pending).toBe(false)
    expect(markAllReadItem().disabled).toBe(true)
  })

  test('without P2P the source lists nothing', async () => {
    p2pState({ enabled: false })
    expect(await p2pInbox.load(DEFAULT_VIEW, null)).toEqual({ entries: [], next: null })
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
    expect(p2pDocVisible(base, dmDoc)).toBe(true)
    expect(p2pDocVisible(base, chDoc)).toBe(true)
    expect(p2pDocVisible({ ...base, enabled: false }, dmDoc)).toBe(false)
    const blockedAlice = { ...base, contacts: [contact(ALICE, 'Alice', 'blocked')] }
    expect(p2pDocVisible(blockedAlice, dmDoc)).toBe(false)
    expect(p2pDocVisible({ ...base, contacts: [] }, dmDoc)).toBe(false)
    const blockedCarol = { ...base, contacts: [contact(CAROL, 'Carol', 'blocked')] }
    expect(p2pDocVisible(blockedCarol, chDoc)).toBe(false)
    for (const m of ['leave', 'ban'] as const)
      expect(p2pDocVisible({ ...base, servers: { [SRV]: server({ me: m }) } }, chDoc)).toBe(false)
    expect(p2pDocVisible({ ...base, servers: { [SRV]: server({ channels: [] }) } }, chDoc)).toBe(
      false
    )
    expect(p2pDocVisible({ ...base, servers: {} }, chDoc)).toBe(false)
    expect(p2pDocPlace(base, dmDoc)).toBe('P2P direct message')
    expect(p2pDocPlace(base, chDoc)).toBe('#general · Book club')
    expect(placesOf(base)).toEqual([
      { room: ROOM, ch: null },
      { room: SRV, ch: CH },
    ])
  })

  test('only stored changes refresh a place, and a refresh drops only in its own bucket', async () => {
    Object.assign(globalThis, { localStorage: memoryStorage })
    memoryStorage.setItem('rchat_palette:bob', JSON.stringify({ v: 1, used: {}, index: 'loaded' }))
    useStore.setState({ me: me('bob') })
    __sync.switchOwner('bob', false)
    const CH2 = 'chan2'
    const v = server({
      channels: [
        { id: CH, name: 'general', kind: 'text', pos: 0 },
        { id: CH2, name: 'random', kind: 'text', pos: 1 },
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
    const stop = startP2pIndex({
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
    const off = registerIndexSource(p2pIndexSource)
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
        visible: (d: Parameters<typeof p2pDocVisible>[1]) => p2pDocVisible(useP2p.getState(), d),
        mask: (t: string) => t,
      } as unknown as ResultCtx
      const s = { ...useStore.getState(), streamer: false }
      const [hit] = messageItems(s, ctx, 'pineapple', 5)
      expect(hit.item.title).toContain('pineapple pizza tonight')
      expect(hit.item.subtitle).toContain('Alice')
      expect(hit.item.subtitle).toContain('P2P direct message')
      p2pState({ enabled: true, contacts: [contact(ALICE, 'Alice', 'blocked')] })
      expect(messageItems(s, ctx, 'pineapple', 5)).toEqual([])
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
    const rooms = { [ROOM]: { id: ROOM, unread: 1, pings: 0 } }
    const out = p2pUnread({ servers, rooms }, EMPTY_NOTIFY, NOW)
    expect(out.servers.map(r => [r.v.name, r.pings, r.channels])).toEqual([
      ['Pinged', 2, 1],
      ['Busy', 0, 1],
    ])
    expect(out.dms).toEqual({ pings: 0, unread: true })
    const muted = setLevel(EMPTY_NOTIFY, { kind: 'p2pc', room: 'c', ch: CH }, 'nothing')
    expect(p2pUnread({ servers, rooms }, muted, NOW).servers.map(r => [r.v.name, r.pings])).toEqual(
      [
        ['Busy', 0],
        ['Pinged', 0],
      ]
    )
  })
})

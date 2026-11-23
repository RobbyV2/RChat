import { createPeerFixture } from './peer_fixture'
import { AccountSession } from '../client/session'
const peerOwner = new AccountSession(home)
afterAll(() => peerOwner.store.dispose())
const peerApp = createPeerFixture(peerOwner, 'ann')
const { p2pDm, openNode, startDeps, startParts, put } = peerApp
import { afterAll, afterEach, describe, expect, test } from 'bun:test'
import { home } from './home_instance'

import { b64u } from '../p2p/canonical'
import { Gossip } from '../p2p/gossip'
import { LOCAL, RANGES, type Local } from '../p2p/limits'
import { LocalHost, serveAcl, WorkerHost, type HostRequest } from '../p2p/resolve_host'
import type { AclRoom } from '../p2p/acl_room'
import type { AdmitOpts } from '../p2p/acl/admit'
import { P2pStore, SEARCH_META } from '../p2p/db'
import type { Message } from '../p2p/frames'
import type { Clock, Session } from '../p2p/session'
import { typingResendMs, type Link } from '../p2p/sync'
import type { TransportLimits } from '../p2p/transport'
import type { NodeDeps, P2pNode } from '../p2p/node'
import { passProblem } from '../p2p/transfer'
import { instanceLocal, runtimeLimits } from '../p2p/user_limits'
import { voiceNotice } from '../p2p/voice'
import type { InstanceInfo } from '../types'
import { memoryStorage } from './fixtures'
import { ManualClock } from './p2p_net'
import {
  general,
  Hub,
  makeMember,
  pump,
  restart,
  stopAll,
  stopMember,
  withLimits,
} from './p2p_server_net'

// Every device-local P2P limit reaches what reads it: the instance's value for a name in each
// section ends up in the part of the account's runtime that uses it, and a few are followed to
// what they bound.

Object.assign(globalThis, { localStorage: memoryStorage })

afterEach(() => {
  stopAll()
  memoryStorage.clear()
})

const MIN = 60_000
const HOUR = 60 * MIN

const failure = (p: Promise<unknown>) =>
  p.then(
    () => 'ok',
    (e: unknown) => (e instanceof Error ? e.message : String(e))
  )

// A clock moved by hand that runs what is due at once, in order, with no waits.
class StepClock implements Clock {
  t = 1_700_000_000_000
  private timers = new Map<number, { at: number; fn: () => void }>()
  private next = 1
  now = () => this.t
  set = (fn: () => void, ms: number) => {
    this.timers.set(this.next, { at: this.t + ms, fn })
    return this.next++
  }
  clear = (h: unknown) => void this.timers.delete(h as number)
  to(end: number) {
    for (;;) {
      const due = [...this.timers.entries()]
        .filter(([, x]) => x.at <= end)
        .sort((x, y) => x[1].at - y[1].at)[0]
      if (!due) break
      this.timers.delete(due[0])
      this.t = Math.max(this.t, due[1].at)
      due[1].fn()
    }
    this.t = end
  }
}

describe('the account limits', () => {
  test('every part of the P2P runtime starts with them', async () => {
    const was = home.info
    const p2p = {
      'local.transport.dialMs': 20_000,
      'local.calls.ringMs': 45_000,
      'local.badge.tickMs': 20 * MIN,
      'local.inbox.pingBatchMs': 80,
      'local.misc.handoverMs': 4000,
      'local.contacts.petnameMax': 16,
      'local.node.tickMs': 20_000,
      'local.sync.horizon': 3000,
      'local.bulk.window': 3,
      'local.gossip.candidates': 8,
      'local.voice.fitAudio': 6,
      'local.server.idleMs': 9000,
      'local.share.room': 0.5,
      'local.dag.walk': 4000,
      'local.search.page': 30,
      'local.acl.holdMs': 10 * MIN,
      'local.cache.mergeCap': 1024,
    }
    home.info = { ...was, limits: { ...was?.limits, p2p } } as InstanceInfo
    try {
      const d = startDeps('ann')
      expect(runtimeLimits(d.limits).leader.handoverMs).toBe(4000)
      // What `boot` makes with them.
      const store = await P2pStore.open(`limits-${Math.random()}`)
      const n = (await openNode(d, store, { name: 'Ann' })) as P2pNode
      const { transport } = (n as unknown as { deps: NodeDeps }).deps
      expect((transport as unknown as { limits: TransportLimits }).limits.dialMs).toBe(20_000)
      const p = startParts(d, store, n)
      expect(p.calls.limits.ringMs).toBe(45_000)
      expect(p.badges.limits.tickMs).toBe(20 * MIN)
      expect(p.keeper.limits.tickMs).toBe(20 * MIN)
      expect(p.pingLog.limits.pingBatchMs).toBe(80)
      expect(n.limits.tickMs).toBe(20_000)
      const contacts = (n as unknown as { contactLimits: Local['contacts'] }).contactLimits
      expect(contacts.petnameMax).toBe(16)
      const { dms, servers } = p
      expect([dms.sync.limits.horizon, servers.sync.limits.horizon]).toEqual([3000, 3000])
      expect(dms.blobs.limits.window).toBe(3)
      expect(servers.gossip.limits.candidates).toBe(8)
      expect(servers.voice.limits.fitAudio).toBe(6)
      expect(servers.local.server.idleMs).toBe(9000)
      expect(servers.storeLimits().share.room).toBe(0.5)
      expect([dms.dag.walk, servers.storeLimits().dag.walk]).toEqual([4000, 4000])
      expect(servers.local.search.page).toBe(30)
      // The evaluator of each room.
      await dms.start()
      await servers.start()
      const room = await servers.create('Limits')
      const host = (servers as unknown as { host: LocalHost }).host
      const r = host.rooms.get(room) as AclRoom
      expect(r.r.local.acl.holdMs).toBe(10 * MIN)
      expect(r.r.acl.cap).toBe(1024)
      // Another account on this instance: the same instance values, none of ann's own.
      expect(startDeps('bob').limits.acl.holdMs).toBe(10 * MIN)
      servers.stop()
      dms.stop()
      n.stop()
      store.close()
    } finally {
      home.info = was
    }
  }, 60_000)

  test('the evaluator in a worker takes them before any room', () => {
    const local = { acl: { ...LOCAL.acl, holdMs: 7 * MIN }, cache: LOCAL.cache }
    const sent: HostRequest[] = []
    const host = new WorkerHost(
      () => ({
        postMessage: m => void sent.push(m as HostRequest),
        onmessage: null,
        onerror: null,
        terminate: () => {},
      }),
      local
    )
    expect(sent).toEqual([{ id: 0, op: 'local', local }])
    host.stop()
    // The worker's side: rooms made after it use them.
    const rooms = new Map<string, AclRoom>()
    const opts: Partial<AdmitOpts> = {}
    const replies: unknown[] = []
    serveAcl(rooms, { id: 0, op: 'local', local }, r => replies.push(r), opts)
    serveAcl(rooms, { id: 1, op: 'wanted', room: 'r' }, r => replies.push(r), opts)
    expect(replies).toEqual([{ id: 1, ok: [] }])
    expect(rooms.get('r')?.r.local.acl.holdMs).toBe(7 * MIN)
  })

  test('the copy that says what they are follows them', () => {
    expect(voiceNotice(LOCAL.voice)).toBe(
      'Voice in P2P servers is peer-to-peer. It works best with up to 8 people (4 with video).'
    )
    expect(voiceNotice({ fitAudio: 12, fitVideo: 6 })).toContain('up to 12 people (6 with video)')
    expect(passProblem('a'.repeat(10), 'a'.repeat(10))).toBeNull()
    expect(passProblem('a'.repeat(10), 'a'.repeat(10), { passMin: 16 })).toBe(
      'Use at least 16 characters'
    )
  })
})

describe('limits that reach their readers', () => {
  test('a server pins at most `dm.pinsMax` messages a channel', async () => {
    const clock = new ManualClock()
    const a = await withLimits(
      l => (l.dm.pinsMax = 2),
      () => makeMember(new Hub(), 'Alice', clock)
    )
    const room = await a.servers.create('Pins')
    const ch = general(a, room)
    const ids: string[] = []
    for (let i = 0; i < 3; i++) ids.push(await a.servers.send(room, { ch, body: `m${i}` }))
    await a.servers.pin(room, ids[0], true)
    await a.servers.pin(room, ids[1], true)
    expect(await failure(a.servers.pin(room, ids[2], true))).toBe('You can pin up to 2 messages')
  }, 60_000)

  test('an invite counts at most `display.codeTtl` past its own time where it is redeemed', async () => {
    for (const [ttl, after] of [
      [HOUR, 'This invite has expired.'],
      [LOCAL.display.codeTtl, 'ok'],
    ] as const) {
      const clock = new ManualClock()
      const hub = new Hub()
      const a = await withLimits(
        l => (l.display.codeTtl = ttl),
        () => makeMember(hub, 'Alice', clock)
      )
      const b = await makeMember(hub, 'Bob', clock)
      const room = await a.servers.create('Codes')
      const code = await a.servers.issueCode(room, 24 * HOUR)
      clock.t += 2 * HOUR
      expect(await failure(b.servers.redeem(code))).toBe(after)
      stopAll()
    }
  }, 120_000)

  test('the search index is built again when the words it keeps change', async () => {
    const clock = new ManualClock()
    const hub = new Hub()
    let m = await makeMember(hub, 'Alice', clock)
    const room = await m.servers.create('Words')
    const ch = general(m, room)
    const id = await m.servers.send(room, { ch, body: 'supercalifragilistic tea' })
    await m.servers.indexing
    const tokens = async () => (await m.store.db.getAllKeys('search')).map(k => k[1]).sort()
    expect(await tokens()).toEqual(['supercalifragilistic', 'tea'])
    const hits = async (q: string) =>
      (await m.servers.search({ ...searchAll, q })).hits.map(h => h.m.body)
    for (const [word, want] of [
      [8, ['supercal', 'tea']],
      [32, ['supercalifragilistic', 'tea']],
    ] as const) {
      stopMember(m)
      m = await withLimits(
        l => (l.search.word = word),
        () => restart(hub, m, clock)
      )
      await m.servers.indexing
      expect(await tokens()).toEqual([...want])
      expect(await m.store.meta(SEARCH_META)).toMatchObject({ done: true, word, words: 256 })
      expect(await hits('supercalifrag')).toEqual(['supercalifragilistic tea'])
    }
    // Rows go with their message, whatever cut they were made with.
    await m.servers.redact(room, id)
    await pump(clock, async () => (await tokens()).length === 0, 'rows gone', 1000)
  }, 60_000)

  test('gossip asks at most `gossip.candidates` members for links a tick', () => {
    const asked = (candidates?: number) => {
      const room = 'R'.repeat(43)
      const members = Array.from({ length: 20 }, (_, i) => `m${i}`)
      const sent: string[] = []
      const session = (ik: string) =>
        ({
          remote: { ik },
          state: 'ready',
          on: () => {},
          onClose: () => {},
          send: (msg: Message) => {
            if (msg.t === 'grlink') sent.push(ik)
            return Promise.resolve()
          },
        }) as unknown as Session
      const sessions = new Map(members.map(ik => [ik, session(ik)]))
      const g = new Gossip({
        clock: new ManualClock(),
        random: () => 0.5,
        me: () => 'me',
        rooms: () => [room],
        members: () => members,
        may: () => 'full',
        shared: () => 0,
        moderator: () => false,
        sessions: ik => [sessions.get(ik) as Session],
        certs: ik => ({ ik, certs: [] }),
        link: () => null,
        unlink: () => {},
        links: () => [] as Link[],
        linksOn: () => [] as Link[],
        onPresence: () => {},
        onTyping: () => {},
        limits: { outTarget: 16, perRoom: 32, ...(candidates ? { candidates } : {}) },
      })
      g.tick()
      return sent.length
    }
    expect(asked()).toBe(16)
    expect(asked(3)).toBe(3)
  })

  test('a typer who says so again every `typingResendMs` of the window stays shown', async () => {
    for (const typingMs of [...RANGES['gossip.typingMs'], LOCAL.gossip.typingMs]) {
      const clock = new ManualClock()
      const room = 'R'.repeat(43)
      const ch = b64u(new Uint8Array(8))
      const handlers = new Map<string, (m: Message) => void>()
      const session = {
        remote: { ik: 'typer' },
        state: 'ready',
        on: (t: string, fn: (m: Message) => void) => void handlers.set(t, fn),
        onClose: () => {},
        send: () => Promise.resolve(),
        strike: () => {},
      } as unknown as Session
      const link = { session, ik: 'typer', room } as unknown as Link
      const g = new Gossip({
        clock,
        random: () => 0.5,
        me: () => 'me',
        rooms: () => [room],
        members: () => ['typer'],
        may: () => 'full',
        shared: () => 0,
        moderator: () => false,
        sessions: () => [session],
        certs: ik => ({ ik, certs: [] }),
        link: () => null,
        unlink: () => {},
        links: () => [link],
        linksOn: () => [link],
        onPresence: () => {},
        onTyping: () => {},
        limits: { typingMs },
      })
      g.attach(session)
      const say = () => handlers.get('gtyping')?.({ t: 'gtyping', room, ch, on: true })
      const every = typingResendMs(typingMs)
      say()
      for (let i = 0; i < 12; i++) {
        await clock.advance(every)
        expect(g.typingIn(room, ch)).toEqual(['typer'])
        say()
      }
      await clock.advance(typingMs)
      expect(g.typingIn(room, ch)).toEqual([])
      expect(every * 2).toBeLessThanOrEqual(typingMs)
    }
    expect(typingResendMs(LOCAL.sync.typingMs)).toBe(3000)
  })

  test('a composer says it is typing again within the window of the place it types in', () => {
    const [dm, server] = [RANGES['sync.typingMs'][0], 4000]
    put.limits({
      ...LOCAL,
      sync: { ...LOCAL.sync, typingMs: dm },
      gossip: { ...LOCAL.gossip, typingMs: server },
    })
    try {
      const room = 'R'.repeat(43)
      expect(p2pDm.typingEvery(room)).toBe(typingResendMs(dm))
      expect(p2pDm.typingEvery(`${room}/general`)).toBe(typingResendMs(server))
      expect(p2pDm.typingEvery(`${room}/general#root`)).toBe(typingResendMs(server))
      expect(typingResendMs(dm)).toBeLessThan(dm)
    } finally {
      put.limits(LOCAL)
    }
  })

  // A typer one relay hop away, every device on `gossip`: the typer hears a key every `keyMs` for
  // `forMs` and says it is typing at the first key, then at the first key at least
  // `typingResendMs` of the window after the last time it said so. The relay passes that on to
  // the viewer. Gives the times (from the first key) the viewer shows and hides the typer, and
  // when the typer last said so.
  const relayed = (gossip: Local['gossip'], keyMs: number, forMs: number) => {
    const clock = new StepClock()
    const start = clock.now()
    const room = 'R'.repeat(43)
    const ch = b64u(new Uint8Array(8))
    const [typer, relayIk, viewerIk] = [1, 2, 3].map(n => b64u(new Uint8Array(32).fill(n)))
    const seen: [number, boolean][] = []
    const peer = (ik: string, deliver: (m: Message) => void = () => {}) => {
      const hear = new Map<string, (m: Message) => void>()
      const session = {
        remote: { ik },
        state: 'ready',
        on: (t: string, fn: (m: Message) => void) => void hear.set(t, fn),
        onClose: () => {},
        send: (m: Message) => {
          deliver(m)
          return Promise.resolve()
        },
        strike: () => {
          throw new Error(`a strike against ${ik}`)
        },
      } as unknown as Session
      return { session, link: { session, ik, room } as unknown as Link, hear }
    }
    const device = (me: string, links: Link[], onTyping: (on: boolean) => void = () => {}) => {
      const g = new Gossip({
        clock,
        random: () => 0.5,
        me: () => me,
        rooms: () => [room],
        members: () => [typer, relayIk, viewerIk],
        may: () => 'full',
        shared: () => 0,
        moderator: () => false,
        sessions: () => links.map(l => l.session),
        certs: ik => ({ ik, certs: [] }),
        link: () => null,
        unlink: () => {},
        links: () => links,
        linksOn: s => links.filter(l => l.session === s),
        onPresence: () => {},
        onTyping: (_room, _place, ik, on) => {
          if (ik === typer) onTyping(on)
        },
        limits: gossip,
      })
      for (const l of links) g.attach(l.session)
      return g
    }
    const fromRelay = peer(relayIk)
    device(viewerIk, [fromRelay.link], on => seen.push([clock.now() - start, on]))
    const fromTyper = peer(typer)
    const toViewer = peer(viewerIk, m => fromRelay.hear.get(m.t)?.(m))
    device(relayIk, [fromTyper.link, toViewer.link])
    const every = typingResendMs(gossip.typingMs)
    let said = -Infinity
    for (let t = 0; t < forMs; t += keyMs) {
      if (t - said < every) continue
      clock.to(start + t)
      fromTyper.hear.get('gtyping')?.({ t: 'gtyping', room, ch, on: true })
      said = t
    }
    clock.to(start + said + gossip.typingMs + 1)
    return { seen, said }
  }

  test('a typer seen through a relay stays shown with the relay interval at half the window', () => {
    const [lo, hi] = RANGES['gossip.typingMs']
    for (const typingMs of [lo, 6000, LOCAL.gossip.typingMs, hi])
      for (const typingRelayMs of new Set(
        [typingMs / 2, LOCAL.gossip.typingRelayMs].filter(r => r * 2 <= typingMs)
      ))
        for (const keyMs of [1, 120, 333]) {
          const gossip = { ...LOCAL.gossip, typingMs, typingRelayMs }
          const { seen, said } = relayed(gossip, keyMs, 6 * typingMs)
          expect(said).toBeGreaterThan(4 * typingMs)
          expect(seen[0]).toEqual([0, true])
          expect(seen.slice(1).filter(([t]) => t <= said)).toEqual([])
          expect(seen.length).toBe(2)
        }
  })

  test('an instance that puts the relay interval over half the window leaves both at their defaults', () => {
    const instance = instanceLocal({ limits: { p2p: { 'local.gossip.typingMs': 1000 } } })
    expect(instance.gossip).toEqual(LOCAL.gossip)
    const kept = relayed(instance.gossip, 120, 6 * LOCAL.gossip.typingMs)
    expect(kept.seen.filter(([t, on]) => !on && t <= kept.said)).toEqual([])
    const taken = { ...LOCAL.gossip, typingMs: 1000 }
    const blinks = relayed(taken, 120, 6000)
    expect(blinks.seen.filter(([t, on]) => !on && t <= blinks.said).length).toBeGreaterThan(1)
  })
})

const searchAll = {
  q: '',
  room: null,
  ch: null,
  from: null,
  hasFile: false,
  beforeTs: null,
  afterTs: null,
}

import { describe, expect, test } from 'bun:test'
import { b64u, randomBytes } from '../p2p/canonical'
import { Gossip, GOSSIP } from '../p2p/gossip'
import type { Message } from '../p2p/frames'
import type { Session } from '../p2p/session'
import type { Link } from '../p2p/sync'
import { ManualClock, prng, settle } from './p2p_net'

// Scale simulation of the server overlay: the real Gossip (candidate ranking, link requests and
// budgets) on many members, over simulated sessions. 300 members, 30 of them online: every
// online member gets a new event within 5 gossip rounds, and nobody links a room more than 8
// times.

// Dials per gossip period: 4 in flight, and a dial to someone offline fails within about a second.
const DIALS = 8
const SESSIONS_MAX = 48
// node.ts LIMITS.backoff.
const BACKOFF = [30_000, 60_000, 120_000, 300_000, 600_000]

class SimSession {
  state = 'ready'
  strikes = 0
  private handlers = new Map<string, (m: Message, s: Session) => void>()
  private closeFns: (() => void)[] = []
  other: SimSession | null = null

  constructor(
    readonly remote: { ik: string },
    readonly peer: string
  ) {}

  on(t: string, fn: (m: Message, s: Session) => void) {
    this.handlers.set(t, fn)
    return this
  }

  onClose(fn: () => void) {
    this.closeFns.push(fn)
  }

  strike() {
    this.strikes += 1
  }

  send(m: Message) {
    const o = this.other
    if (this.state !== 'ready' || !o) return Promise.resolve()
    const copy = JSON.parse(JSON.stringify(m)) as Message
    queueMicrotask(() => {
      if (o.state === 'ready') o.handlers.get(copy.t)?.(copy, o as unknown as Session)
    })
    return Promise.resolve()
  }

  close() {
    for (const s of [this, this.other]) {
      if (!s || s.state === 'closed') continue
      s.state = 'closed'
      for (const fn of s.closeFns) fn()
    }
  }
}

interface SimNode {
  ik: string
  gossip: Gossip
  sessions: Map<string, SimSession>
  links: Map<string, Map<SimSession, Link>>
  failedUntil: Map<string, { until: number; attempt: number }>
}

const simulate = (seed: number, total = 300, online = 30) => {
  const rand = prng(seed)
  const clock = new ManualClock()
  const room = b64u(randomBytes(32))
  const members = Array.from({ length: total }, (_, i) => `m${String(i).padStart(3, '0')}`)
  const owner = members[0]
  const live = new Set([...members].sort(() => rand() - 0.5).slice(0, online))
  const nodes = new Map<string, SimNode>()
  for (const ik of live) {
    const node: SimNode = {
      ik,
      sessions: new Map(),
      links: new Map([[room, new Map()]]),
      failedUntil: new Map(),
      gossip: null as unknown as Gossip,
    }
    const linksOf = () => [...(node.links.get(room)?.values() ?? [])]
    node.gossip = new Gossip({
      clock,
      random: rand,
      me: () => ik,
      rooms: () => [room],
      members: () => members.filter(x => x !== ik),
      may: (_r, other) => (members.includes(other) ? 'full' : false),
      // Some members share more rooms with some than with others.
      shared: other => (other.charCodeAt(3) + ik.charCodeAt(3)) % 3,
      moderator: (_r, other) => other === owner,
      dialable: other => {
        const f = node.failedUntil.get(other)
        return !f || f.until <= clock.now()
      },
      // Like the node: a session left without room links is closed.
      idle: s => queueMicrotask(() => (s as unknown as SimSession).close()),
      sessions: other => {
        const s = node.sessions.get(other)
        return s && s.state === 'ready' ? [s as unknown as Session] : []
      },
      certs: other => ({ ik: other, certs: [] }),
      link: (s, r) => {
        const sim = s as unknown as SimSession
        const byS = node.links.get(r) as Map<SimSession, Link>
        const have = byS.get(sim)
        if (have) return have
        const l = { session: s, ik: sim.remote.ik, room: r } as unknown as Link
        byS.set(sim, l)
        return l
      },
      unlink: (s, r) => void node.links.get(r)?.delete(s as unknown as SimSession),
      links: () => linksOf(),
      linksOn: s => linksOf().filter(l => (l.session as unknown) === s),
      onPresence: () => {},
      onTyping: () => {},
    })
    nodes.set(ik, node)
  }
  const connect = (a: SimNode, b: SimNode) => {
    const sa = new SimSession({ ik: b.ik }, `peer-${b.ik}`)
    const sb = new SimSession({ ik: a.ik }, `peer-${a.ik}`)
    sa.other = sb
    sb.other = sa
    a.sessions.set(b.ik, sa)
    b.sessions.set(a.ik, sb)
    for (const [n, s] of [
      [a, sa],
      [b, sb],
    ] as const) {
      n.gossip.attach(s as unknown as Session)
      s.onClose(() => {
        n.sessions.delete(s.remote.ik)
        n.links.get(room)?.delete(s)
      })
    }
    a.gossip.ready(sa as unknown as Session)
    b.gossip.ready(sb as unknown as Session)
  }
  // The dialer of a node (node.ts): wanted members without a session, a few at a time; members
  // who don't answer are left alone for a while.
  // Like node.schedule(), which asks for targets again after every dial.
  const dialRound = () => {
    for (const n of nodes.values()) {
      let dials = 0
      while (dials < DIALS && n.sessions.size < SESSIONS_MAX) {
        const t = n.gossip.targets().find(x => {
          const failed = n.failedUntil.get(x.ik)
          return !n.sessions.has(x.ik) && !(failed && failed.until > clock.now())
        })
        if (!t) break
        const failed = n.failedUntil.get(t.ik)
        dials += 1
        const other = nodes.get(t.ik)
        if (!other || other.sessions.size >= SESSIONS_MAX) {
          const attempt = Math.min((failed?.attempt ?? -1) + 1, BACKOFF.length - 1)
          n.failedUntil.set(t.ik, { until: clock.now() + BACKOFF[attempt], attempt })
          continue
        }
        connect(n, other)
      }
    }
  }
  // One gossip period: dials, then every node's tick (the timers gossip.start() would run).
  const round = async () => {
    dialRound()
    await settle(3)
    for (const n of nodes.values()) n.gossip.tick()
    await settle(3)
    clock.t += GOSSIP.tickMs
  }
  // A member drops off and comes back: all its sessions close.
  const churn = (n: number) => {
    const list = [...nodes.values()]
    for (let i = 0; i < n; i += 1) {
      const node = list[Math.floor(rand() * list.length)]
      for (const s of [...node.sessions.values()]) s.close()
    }
  }
  return { clock, room, nodes, round, churn, owner }
}

const linkCount = (n: SimNode, room: string) => n.links.get(room)?.size ?? 0

// Hops from `origin` until everyone online has the event: each round, everyone who has it hands
// it to their room links.
const rounds = (nodes: Map<string, SimNode>, room: string, origin: string, max = 20) => {
  const have = new Set([origin])
  let r = 0
  while (have.size < nodes.size && r < max) {
    r += 1
    for (const ik of [...have])
      for (const l of nodes.get(ik)?.links.get(room)?.values() ?? []) have.add(l.ik)
  }
  return have.size === nodes.size ? r : Infinity
}

describe('gossip at scale', () => {
  // Every node's sessions after each round: the per-room budget is a hard cap (sessions answered
  // busy close), and nobody (not the owner either) turns into a hub.
  test('300 members, all online, with churn: at most 8 sessions per node, no hub, everyone reached', async () => {
    for (const seed of [7, 8]) {
      const sim = simulate(seed, 300, 300)
      try {
        let worst = 0
        for (let i = 0; i < 30; i += 1) {
          if (i > 5 && i < 25) sim.churn(15)
          await sim.round()
          await settle(3)
          for (const n of sim.nodes.values()) {
            expect(linkCount(n, sim.room)).toBeLessThanOrEqual(GOSSIP.perRoom)
            worst = Math.max(worst, n.sessions.size)
          }
        }
        // Sessions with room links stay within the budget; the rest are dials of the last
        // period whose answer is pending, and close if they find no use. Before the fix the
        // owner held a session with everyone online (29 to 48).
        const sizes = [...sim.nodes.values()].map(n => n.sessions.size)
        expect(sizes.reduce((a, b) => a + b, 0) / sizes.length).toBeLessThanOrEqual(GOSSIP.perRoom)
        expect(worst).toBeLessThanOrEqual(GOSSIP.perRoom + DIALS)
        expect((sim.nodes.get(sim.owner) as SimNode).sessions.size).toBeLessThanOrEqual(
          GOSSIP.perRoom + DIALS
        )
        let far = 0
        for (const origin of [...sim.nodes.keys()].slice(0, 30))
          far = Math.max(far, rounds(sim.nodes, sim.room, origin))
        expect(far).toBeLessThanOrEqual(6)
      } catch (e) {
        console.error(`scale seed ${seed}`)
        throw e
      }
    }
  }, 240_000)

  test('300 members, 30 online: everyone gets an event within 5 rounds, at most 8 links each', async () => {
    for (const seed of [11, 22, 33, 44, 55, 66]) {
      const sim = simulate(seed)
      try {
        for (let i = 0; i < 40; i += 1) await sim.round()
        for (const n of sim.nodes.values())
          expect(linkCount(n, sim.room)).toBeLessThanOrEqual(GOSSIP.perRoom)
        // Links are agreed: both ends hold them.
        for (const n of sim.nodes.values())
          for (const l of n.links.get(sim.room)?.values() ?? [])
            expect(
              [...(sim.nodes.get(l.ik)?.links.get(sim.room)?.values() ?? [])].some(
                x => x.ik === n.ik
              )
            ).toBe(true)
        let worst = 0
        for (const origin of sim.nodes.keys())
          worst = Math.max(worst, rounds(sim.nodes, sim.room, origin))
        expect(worst).toBeLessThanOrEqual(5)
        // Re-sampling keeps the overlay connected and within budget.
        sim.clock.t += GOSSIP.resampleMs
        for (const n of sim.nodes.values()) n.gossip.resample()
        for (let i = 0; i < 20; i += 1) await sim.round()
        let after = 0
        for (const origin of sim.nodes.keys())
          after = Math.max(after, rounds(sim.nodes, sim.room, origin))
        expect(after).toBeLessThanOrEqual(5)
        for (const n of sim.nodes.values())
          expect(linkCount(n, sim.room)).toBeLessThanOrEqual(GOSSIP.perRoom)
      } catch (e) {
        console.error(`scale seed ${seed}`)
        throw e
      }
    }
  }, 120_000)
})

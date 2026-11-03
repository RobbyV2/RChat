import { describe, expect, test } from 'bun:test'
import { ManualClock, settle } from './p2p_net'
import { b64u, randomBytes } from '../p2p/canonical'
import type { Message } from '../p2p/frames'
import { keyId, newKeyPair, signTagged, type Cert, type KeyPair } from '../p2p/keys'
import { LIMITS, victimFor, type Held } from '../p2p/node'
import type { Session } from '../p2p/session'
import {
  pastFit,
  readVoiceFrame,
  readVoiceRefuse,
  readVoiceRtc,
  Voice,
  VOICE_TAG,
  voiceBody,
  VoiceRoster,
  type VoiceFrame,
  type VoiceMedia,
} from '../p2p/voice'

const ROOM = b64u(randomBytes(32))
const CH = b64u(randomBytes(8))
const CH2 = b64u(randomBytes(8))
const ik = () => keyId(newKeyPair().pk)

// ----- An in-memory room: nodes, sessions between them, frames delivered in order -----

interface Node {
  name: string
  ik: string
  dk: string
  dkKey: KeyPair
  voice: Voice
  media: FakeMedia
  sessions: Map<string, FakeSession>
  // Members this node may not show in a channel (lost view).
  hidden: Set<string>
  consent: ((hosts: string[]) => Promise<string | null>) | null
}

class FakeMedia implements VoiceMedia {
  users: string[] = []
  joined = false
  async join() {
    this.joined = true
  }
  sync(users: string[]) {
    this.users = users
  }
  leave() {
    this.joined = false
    this.users = []
  }
  signals: string[] = []
  async onSignal(from: string) {
    this.signals.push(from)
  }
}

class Net {
  clock = new ManualClock()
  nodes: Node[] = []
  queue: (() => Promise<unknown> | unknown)[] = []
  // Frames held back (delivered later, out of order).
  held: (() => Promise<unknown> | unknown)[] = []
  hold: ((from: Node, to: Node, m: Message) => boolean) | null = null
  // Who is a link of whom (default: every session), and members who left the room.
  linked: (a: Node, b: Node) => boolean = () => true
  out = new Set<string>()

  // `as`: another device of that node's identity.
  add(name: string, as?: Node) {
    const dkKey = newKeyPair()
    const node: Node = {
      name,
      ik: as?.ik ?? ik(),
      dk: keyId(dkKey.pk),
      dkKey,
      media: new FakeMedia(),
      sessions: new Map(),
      hidden: new Set(),
      consent: null,
      voice: null as unknown as Voice,
    }
    const ready = () => [...node.sessions.values()].filter(s => s.state === 'ready')
    node.voice = new Voice({
      clock: this.clock,
      me: () => node.ik,
      sessions: () => ready() as unknown as Session[],
      links: () => ready().filter(s => this.linked(node, s.to.owner)) as unknown as Session[],
      sessionsOf: x => ready().filter(s => s.remote.ik === x) as unknown as Session[],
      member: (_room, x) => this.nodes.some(n => n.ik === x) && !this.out.has(x),
      isVoice: (_room, ch) => ch === CH || ch === CH2,
      device: (_room, x, dk) => this.nodes.some(n => n.ik === x && n.dk === dk),
      signer: () => ({ dk: node.dk, sk: node.dkKey.sk }),
      allowed: (_room, _ch, x) => !node.hidden.has(x),
      certs: x => ({
        ik: x,
        certs: this.nodes.filter(n => n.ik === x).map(n => ({ dk: n.dk }) as unknown as Cert),
      }),
      onChange: () => {},
    })
    node.voice.media = node.media
    node.voice.consent = hosts => node.consent?.(hosts) ?? Promise.resolve(null)
    node.voice.start()
    this.nodes.push(node)
    return node
  }

  connect(a: Node, b: Node) {
    const sa = new FakeSession(this, a, b)
    const sb = new FakeSession(this, b, a)
    sa.to = sb
    sb.to = sa
    a.sessions.set(b.dk, sa)
    b.sessions.set(a.dk, sb)
    a.voice.attach(sa as unknown as Session)
    b.voice.attach(sb as unknown as Session)
    a.voice.ready(sa as unknown as Session)
    b.voice.ready(sb as unknown as Session)
  }

  cut(a: Node, b: Node) {
    a.sessions.get(b.dk)?.close()
    b.sessions.get(a.dk)?.close()
    a.sessions.delete(b.dk)
    b.sessions.delete(a.dk)
  }

  line(list: Node[]) {
    for (let i = 0; i + 1 < list.length; i += 1) this.connect(list[i], list[i + 1])
  }

  mesh(list: Node[]) {
    for (let i = 0; i < list.length; i += 1)
      for (let j = i + 1; j < list.length; j += 1) this.connect(list[i], list[j])
  }

  async flush() {
    for (let round = 0; round < 50; round += 1) {
      await settle(3)
      if (!this.queue.length) break
      while (this.queue.length) await this.queue.shift()!()
    }
  }

  async step(ms: number, by = 5_000) {
    for (let t = 0; t < ms; t += by) {
      await this.clock.advance(Math.min(by, ms - t))
      await this.flush()
    }
  }

  async release() {
    const held = this.held
    this.held = []
    for (const f of held) await f()
    await this.flush()
  }
}

class FakeSession {
  state: 'ready' | 'closed' = 'ready'
  openedAt: number
  remote: { ik: string; dk: string }
  to!: FakeSession
  strikes = 0
  // Frames sent over this session.
  sent: Message[] = []
  private handlers = new Map<string, (m: Message, s: FakeSession) => unknown>()
  private closeFns: ((s: FakeSession, why: string) => void)[] = []

  constructor(
    private net: Net,
    readonly owner: Node,
    other: Node
  ) {
    this.remote = { ik: other.ik, dk: other.dk }
    this.openedAt = net.clock.now()
  }

  on(t: string, fn: (m: Message, s: FakeSession) => unknown) {
    this.handlers.set(t, fn)
    return this
  }

  onClose(fn: (s: FakeSession, why: string) => void) {
    this.closeFns.push(fn)
  }

  send(m: Message) {
    if (this.state !== 'ready') return Promise.resolve()
    const to = this.to
    const copy = JSON.parse(JSON.stringify(m)) as Message
    this.sent.push(copy)
    const run = () => to.deliver(copy)
    if (this.net.hold?.(this.owner, to.owner, copy)) this.net.held.push(run)
    else this.net.queue.push(run)
    return Promise.resolve()
  }

  async deliver(m: Message) {
    if (this.state !== 'ready') return
    const fn = this.handlers.get(m.t as string)
    if (fn) await fn(m, this)
  }

  strike() {
    this.strikes += 1
  }

  useful() {}

  close() {
    if (this.state === 'closed') return
    this.state = 'closed'
    for (const fn of this.closeFns) fn(this, 'remote')
  }
}

const inCh = (n: Node, ch = CH) => (n.voice.channels(ROOM)[ch] ?? []).map(u => u.ik).sort()
const names = (net: Net, iks: string[]) =>
  iks.map(x => net.nodes.find(n => n.ik === x)?.name ?? '?').sort()
const plan = { config: { iceServers: [] }, declared: [], hidesIp: false }

const DK = ik()
const SIG = b64u(randomBytes(64))

const frame = (over: Record<string, unknown> = {}) => ({
  t: 'gvoice',
  room: ROOM,
  ch: CH,
  on: true,
  n: 5,
  dk: DK,
  sig: SIG,
  ...over,
})

const passOn = (m: Message, who: string, over: Record<string, unknown> = {}) =>
  ({ ...m, ik: who, ...over }) as Message

// A frame about `who`, signed by its device (as it would have sent it).
const signedBy = (who: Node, over: Partial<VoiceFrame> = {}): Message => {
  const f = { room: ROOM, ch: CH, on: true, n: 5, ...over }
  const sig = signTagged(who.dkKey.sk, VOICE_TAG, voiceBody(f, who.ik))
  return { t: 'gvoice', ...f, dk: who.dk, sig } as unknown as Message
}

describe('P2P voice frames', () => {
  test('known fields are checked, unknown ones ignored', () => {
    const base = { t: 'gvoice' as const, room: ROOM, ch: CH, on: true, n: 5, dk: DK, sig: SIG }
    expect(readVoiceFrame(frame())).toEqual(base)
    expect(readVoiceFrame(frame({ later: { x: 1 }, video: true }))).toEqual({
      ...base,
      video: true,
    })
    const who = ik()
    expect(readVoiceFrame(frame({ ik: who, relays: ['turn.example.org'] }))?.ik).toBe(who)
    for (const bad of [
      frame({ on: 'yes' }),
      frame({ n: -1 }),
      frame({ n: 1.5 }),
      frame({ ch: 'general' }),
      frame({ room: 'x' }),
      frame({ video: 1 }),
      frame({ ik: 'nobody' }),
      frame({ relays: ['not a host!'] }),
      frame({ dk: 'x' }),
      frame({ sig: 'short' }),
      { t: 'gvoice', room: ROOM, ch: CH, on: true, n: 5 },
    ])
      expect(readVoiceFrame(bad)).toBeNull()
  })

  test('negotiation frames carry only what rtc.ts knows', () => {
    const to = ik()
    const f = readVoiceRtc({
      t: 'gvrtc',
      to,
      target: { p2pRoom: ROOM, ch: CH, extra: 1 },
      payload: { muted: true, sid: 'ab12', later: 'x' },
      also: true,
    })
    expect(f).toEqual({
      t: 'gvrtc',
      to,
      target: { p2pRoom: ROOM, ch: CH },
      payload: { muted: true, sid: 'ab12' },
    })
    expect(readVoiceRtc({ t: 'gvrtc', to, target: { p2pRoom: ROOM }, payload: {} })).toBeNull()
    expect(
      readVoiceRtc({ t: 'gvrtc', to, target: { p2pRoom: ROOM, ch: CH }, payload: { muted: 1 } })
    ).toBeNull()
  })

  test('the notice shows past 8 people, or past 4 with video', () => {
    expect(pastFit(8, false)).toBe(false)
    expect(pastFit(9, false)).toBe(true)
    expect(pastFit(4, true)).toBe(false)
    expect(pastFit(5, true)).toBe(true)
  })
})

describe('the voice roster', () => {
  test('a late copy never undoes a newer frame, and silence expires', () => {
    const r = new VoiceRoster(60_000)
    const a = ik()
    expect(r.apply(ROOM, a, { ch: CH, on: true, n: 10 }, 0, false)).toBe(true)
    expect(r.apply(ROOM, a, { ch: CH, on: false, n: 11 }, 1, false)).toBe(true)
    expect(r.apply(ROOM, a, { ch: CH, on: true, n: 10 }, 2, false)).toBe(false)
    expect(r.in(ROOM, CH, 2)).toEqual([])
    r.apply(ROOM, a, { ch: CH2, on: true, n: 12 }, 3, false)
    expect(r.in(ROOM, CH2, 3)).toEqual([a])
    expect(r.in(ROOM, CH2, 60_003)).toEqual([a])
    expect(r.in(ROOM, CH2, 60_004)).toEqual([])
    expect(r.prune(60_004)).toEqual([ROOM])
    // Expired, but its stamp is remembered: an old copy passed on again doesn't come back.
    expect(r.apply(ROOM, a, { ch: CH2, on: true, n: 12 }, 60_005, false)).toBe(false)
    expect(r.apply(ROOM, a, { ch: CH2, on: true, n: 13 }, 60_005, false)).toBe(true)
  })

  test("a participant's own word beats what is passed on about them", () => {
    const r = new VoiceRoster(60_000)
    const a = ik()
    r.apply(ROOM, a, { ch: CH, on: true, n: 10 }, 0, true)
    // A forged copy with a huge stamp doesn't take a fresh direct state over.
    expect(r.apply(ROOM, a, { ch: CH, on: false, n: 2 ** 52 }, 1, false)).toBe(false)
    expect(r.in(ROOM, CH, 1)).toEqual([a])
    // And their own frame replaces a passed-on one whatever its stamp.
    const b = ik()
    r.apply(ROOM, b, { ch: CH, on: true, n: 2 ** 52 }, 0, false)
    expect(r.apply(ROOM, b, { ch: CH, on: false, n: 7 }, 1, true)).toBe(true)
    expect(r.in(ROOM, CH, 1)).toEqual([a])
  })
})

describe('voice participant sets', () => {
  test('converge with joins and leaves under a partition', async () => {
    const net = new Net()
    const [a, b, c, d, e] = ['A', 'B', 'C', 'D', 'E'].map(n => net.add(n))
    net.mesh([a, b, c, d, e])
    for (const n of [a, b, c]) await n.voice.join(ROOM, CH, { plan, muted: false })
    await net.flush()
    for (const n of net.nodes) expect(names(net, inCh(n))).toEqual(['A', 'B', 'C'])
    expect(names(net, a.media.users)).toEqual(['A', 'B', 'C'])

    // {A, B} | {C, D, E}
    for (const x of [a, b]) for (const y of [c, d, e]) net.cut(x, y)
    b.voice.leave()
    await d.voice.join(ROOM, CH, { plan, muted: false })
    await e.voice.join(ROOM, CH, { plan, muted: false })
    await net.flush()
    e.voice.leave()
    await net.step(65_000)
    for (const n of [a, b]) expect(names(net, inCh(n))).toEqual(['A'])
    for (const n of [c, d, e]) expect(names(net, inCh(n))).toEqual(['C', 'D'])
    expect(names(net, a.media.users)).toEqual(['A'])
    expect(names(net, c.media.users)).toEqual(['C', 'D'])

    // Healed: everyone hears the same three at once.
    for (const x of [a, b]) for (const y of [c, d, e]) net.connect(x, y)
    await net.flush()
    for (const n of net.nodes) expect(names(net, inCh(n))).toEqual(['A', 'C', 'D'])
    for (const n of [a, c, d]) expect(names(net, n.media.users)).toEqual(['A', 'C', 'D'])
    expect(b.media.users).toEqual([])

    // One leaves, the others go on; refreshes keep the rest listed.
    c.voice.leave()
    await net.flush()
    await net.step(90_000)
    for (const n of net.nodes) expect(names(net, inCh(n))).toEqual(['A', 'D'])
    for (const n of [a, d]) expect(names(net, n.media.users)).toEqual(['A', 'D'])
  }, 60_000)

  test('a leave is never undone by a late copy of an older frame', async () => {
    const net = new Net()
    const [a, r, b] = ['A', 'R', 'B'].map(n => net.add(n))
    net.mesh([a, r, b])
    await a.voice.join(ROOM, CH, { plan, muted: false })
    await net.flush()
    // R's copies of A's next frame reach B late.
    net.hold = (from, to, m) => from === r && to === b && m.ik === a.ik
    await net.step(20_000)
    a.voice.leave()
    await net.flush()
    expect(inCh(b)).toEqual([])
    net.hold = null
    await net.release()
    expect(inCh(b)).toEqual([])
  })

  test('participants any number of links apart find each other: a 5-link chain', async () => {
    const net = new Net()
    const chain = ['A', 'B', 'C', 'D', 'E', 'F'].map(n => net.add(n))
    const [a, , , , , f] = chain
    net.line(chain)
    await a.voice.join(ROOM, CH, { plan, muted: false })
    await net.step(2_000, 1_000)
    for (const n of chain) expect(names(net, inCh(n))).toEqual(['A'])
    await f.voice.join(ROOM, CH, { plan, muted: false })
    await net.step(2_000, 1_000)
    for (const n of chain) expect(names(net, inCh(n))).toEqual(['A', 'F'])
    // Each dials the other's voice device, and once connected their media meets.
    expect(
      names(
        net,
        a.voice.targets().map(t => t.ik)
      )
    ).toEqual(['F'])
    expect(f.voice.targets().map(t => t.certs.map(c => c.dk))).toEqual([[a.dk]])
    net.connect(a, f)
    await net.flush()
    expect(names(net, a.media.users)).toEqual(['A', 'F'])
    expect(names(net, f.media.users)).toEqual(['A', 'F'])
  })

  test('near-simultaneous joins three links apart converge', async () => {
    const net = new Net()
    const chain = ['A', 'B', 'C', 'D'].map(n => net.add(n))
    const [a, , , d] = chain
    net.line(chain)
    await Promise.all([
      a.voice.join(ROOM, CH, { plan, muted: false }),
      d.voice.join(ROOM, CH, { plan, muted: false }),
    ])
    await net.step(2_000, 1_000)
    for (const n of chain) expect(names(net, inCh(n))).toEqual(['A', 'D'])
    // A refresh still reaches the far end after the joins (each state crosses each link once).
    await net.step(25_000)
    for (const n of chain) expect(names(net, inCh(n))).toEqual(['A', 'D'])
  })

  test('a member flipping its state is passed on at most once a second, the latest last', async () => {
    const net = new Net()
    const [f, r, l] = ['F', 'R', 'L'].map(n => net.add(n))
    net.connect(f, r)
    net.connect(r, l)
    const s = r.sessions.get(f.dk)!
    const toL = r.sessions.get(l.dk)!
    const t = net.clock.now()
    for (let i = 1; i <= 30; i += 1)
      await s.deliver(signedBy(f, { n: t + i, ch: i % 2 ? CH : CH2, on: true }))
    const passed = () => toL.sent.filter(m => m.t === 'gvoice' && m.ik === f.ik)
    expect(passed().length).toBe(1)
    await net.step(1_000, 1_000)
    expect(passed().map(m => m.n)).toEqual([t + 1, t + 30])
    expect(names(net, inCh(l, CH2))).toEqual(['F'])
    expect(inCh(l, CH)).toEqual([])
    // An unchanged state again soon after isn't passed on.
    await s.deliver(signedBy(f, { n: t + 31, ch: CH2, on: true }))
    await net.step(1_000, 1_000)
    expect(passed().length).toBe(2)
  })

  test('the throttle never passes an older state last: on, off, on within a gap ends on', async () => {
    const net = new Net()
    const [f, r, l] = ['F', 'R', 'L'].map(n => net.add(n))
    net.connect(f, r)
    net.connect(r, l)
    const s = r.sessions.get(f.dk)!
    const t = net.clock.now()
    await s.deliver(signedBy(f, { n: t + 1, on: true }))
    await s.deliver(signedBy(f, { n: t + 2, on: false }))
    await s.deliver(signedBy(f, { n: t + 3, on: true }))
    await net.step(1_000, 1_000)
    expect(names(net, inCh(r))).toEqual(['F'])
    expect(names(net, inCh(l))).toEqual(['F'])
    // 31 flips ending on the first channel end there for the far end too.
    for (let i = 4; i <= 34; i += 1)
      await s.deliver(signedBy(f, { n: t + i, ch: i % 2 ? CH2 : CH, on: true }))
    await net.step(6_000, 1_000)
    expect(names(net, inCh(r, CH))).toEqual(['F'])
    expect(names(net, inCh(l, CH))).toEqual(['F'])
    expect(inCh(l, CH2)).toEqual([])
  })

  test('at most linkPerSec frames a second are passed on over one link', async () => {
    const net = new Net()
    const [r, l] = ['R', 'L'].map(n => net.add(n))
    const many = Array.from({ length: 25 }, (_, i) => net.add(`M${i}`))
    net.connect(r, l)
    for (const m of many) net.connect(m, r)
    const t = net.clock.now()
    for (const m of many) await r.sessions.get(m.dk)!.deliver(signedBy(m, { n: t }))
    const toL = r.sessions.get(l.dk)!
    expect(toL.sent.filter(m => m.t === 'gvoice').length).toBe(r.voice.limits.linkPerSec)
    // R itself heard all of them.
    expect(inCh(r).length).toBe(25)
  })

  test('a session sending too fast has the rest dropped (a bucket with room for a list)', async () => {
    const net = new Net()
    const [a, b] = ['A', 'B'].map(n => net.add(n))
    net.connect(a, b)
    const s = a.sessions.get(b.dk)!
    const t = net.clock.now()
    for (let i = 1; i <= 200; i += 1) await s.deliver(signedBy(b, { n: t + i, on: i % 2 === 0 }))
    const heard = a.voice.roster.state(ROOM, b.ik, t + 1000) ?? { n: -1 }
    // The bucket's burst, then nothing until it refills.
    expect(heard.n).toBe(t + a.voice.limits.inBurst)
    await net.step(1_000, 1_000)
    await s.deliver(signedBy(b, { n: t + 500 }))
    expect(a.voice.roster.state(ROOM, b.ik, net.clock.now())?.n).toBe(t + 500)
  })

  test("frames from or about someone who isn't a member are ignored without a strike", async () => {
    const net = new Net()
    const [a, b, x] = ['A', 'B', 'X'].map(n => net.add(n))
    net.mesh([a, b, x])
    await x.voice.join(ROOM, CH, { plan, muted: false })
    await net.flush()
    expect(names(net, inCh(a))).toEqual(['X'])
    // X is banned (out of the room): its state goes from the lists, and its frames count for
    // nothing, from it or passed on.
    net.out.add(x.ik)
    await a.voice.recheck(ROOM)
    expect(inCh(a)).toEqual([])
    const t = net.clock.now()
    await a.sessions.get(x.dk)!.deliver(signedBy(x, { n: t + 1 }))
    await a.sessions.get(b.dk)!.deliver(passOn(signedBy(x, { n: t + 2 }), x.ik))
    expect(inCh(a)).toEqual([])
    expect(a.sessions.get(x.dk)!.strikes + a.sessions.get(b.dk)!.strikes).toBe(0)
  })

  test('a participant with two devices online gets media on the one in voice', async () => {
    const net = new Net()
    const a = net.add('A')
    const b = net.add('B')
    const laptop = net.add('X')
    const desk = net.add('X', laptop)
    // A has a session with X's laptop (not in voice); X is in voice on its desktop, which only
    // B can reach.
    net.connect(a, laptop)
    net.connect(a, b)
    net.connect(b, desk)
    await desk.voice.join(ROOM, CH, { plan, muted: false })
    await net.step(12_000, 1_000)
    await a.voice.join(ROOM, CH, { plan, muted: false })
    await net.flush()
    expect(names(net, inCh(a))).toEqual(['A', 'X'])
    // Not connected to the voice device yet: no media, and the desktop is what A dials.
    expect(names(net, a.media.users)).toEqual(['A'])
    expect(a.voice.targets().map(t => t.certs.map(c => c.dk))).toEqual([[desk.dk]])
    expect(a.voice.keeps(desk.ik, laptop.dk)).toBe(false)
    net.connect(a, desk)
    await net.flush()
    expect(names(net, a.media.users)).toEqual(['A', 'X'])
    expect(a.voice.keeps(desk.ik, desk.dk)).toBe(true)
    // Negotiation goes to the desktop, and only the desktop's is taken.
    a.voice.send(desk.ik, { p2pRoom: ROOM, ch: CH }, { muted: false })
    expect(a.sessions.get(desk.dk)!.sent.some(m => m.t === 'gvrtc')).toBe(true)
    expect(a.sessions.get(laptop.dk)!.sent.some(m => m.t === 'gvrtc')).toBe(false)
    const rtc = { t: 'gvrtc', to: a.ik, target: { p2pRoom: ROOM, ch: CH }, payload: {} } as Message
    await a.sessions.get(laptop.dk)!.deliver(rtc)
    expect(a.media.signals).toEqual([])
    await a.sessions.get(desk.dk)!.deliver(rtc)
    expect(names(net, a.media.signals)).toEqual(['X'])
    // The desktop's session goes (the laptop's stays) and X isn't heard of again: gone.
    desk.voice.stop()
    b.voice.stop()
    net.cut(a, desk)
    net.cut(b, desk)
    await net.step(a.voice.limits.lostMs, 5_000)
    expect(names(net, inCh(a))).toEqual(['A'])
  })

  test('relay consent: a participant joins media once allowed, never when denied', async () => {
    const net = new Net()
    const [a, b, c] = ['A', 'B', 'C'].map(n => net.add(n))
    net.mesh([a, b, c])
    const relayed = { ...plan, declared: ['turn.b.example'] }
    const asked: string[][] = []
    let answer: (denied: string | null) => void = () => {}
    a.consent = hosts => {
      asked.push(hosts)
      return new Promise(r => (answer = r))
    }
    const denied: string[] = []
    a.voice.denied = ik => denied.push(ik)
    await b.voice.join(ROOM, CH, { plan: relayed, muted: false })
    await a.voice.join(ROOM, CH, { plan, muted: false })
    await net.flush()
    // Asked once about B's relay; B waits, nothing else does.
    expect(asked).toEqual([['turn.b.example']])
    expect(names(net, a.media.users)).toEqual(['A'])
    answer(null)
    await net.flush()
    expect(names(net, a.media.users)).toEqual(['A', 'B'])
    // C declares a relay that is denied: left out, with a notice.
    await c.voice.join(ROOM, CH, { plan: { ...plan, declared: ['turn.c.example'] }, muted: false })
    await net.flush()
    expect(asked[1]).toEqual(['turn.c.example'])
    answer('turn.c.example')
    await net.flush()
    expect(names(net, a.media.users)).toEqual(['A', 'B'])
    expect(names(net, denied)).toEqual(['C'])
    // B's relays change: asked again.
    b.voice.leave()
    await b.voice.join(ROOM, CH, {
      plan: { ...plan, declared: ['turn.b2.example'] },
      muted: false,
    })
    await net.flush()
    expect(asked[2]).toEqual(['turn.b2.example'])
    expect(names(net, a.media.users)).toEqual(['A'])
    // Relayed candidates only on our side: nobody's relay sees our address, nobody is asked.
    const quiet = net.add('Q')
    net.connect(quiet, b)
    quiet.consent = () => Promise.reject(new Error('asked'))
    await quiet.voice.join(ROOM, CH, { plan: { ...plan, hidesIp: true }, muted: false })
    await net.flush()
    expect(names(net, quiet.media.users)).toEqual(['B', 'Q'])
  })

  test('a join that may not go ahead ends nothing else', async () => {
    const net = new Net()
    const a = net.add('A')
    let left = 0
    let planned = 0
    const o = {
      plan: async () => {
        planned += 1
        return plan
      },
      muted: false,
      leaveOthers: () => void (left += 1),
    }
    const err = await a.voice.join(ROOM, b64u(randomBytes(8)), o).catch((e: Error) => e.message)
    expect(err).toBe("You can't join this voice channel.")
    a.hidden.add(a.ik)
    expect(await a.voice.join(ROOM, CH, o).catch((e: Error) => e.message)).toBe(err)
    expect([left, planned]).toEqual([0, 0])
    // A plan that fails (a relay gone) ends nothing either.
    a.hidden.clear()
    const bad = { ...o, plan: () => Promise.reject(new Error('That relay is gone')) }
    expect(await a.voice.join(ROOM, CH, bad).catch((e: Error) => e.message)).toBe(
      'That relay is gone'
    )
    expect(left).toBe(0)
    await a.voice.join(ROOM, CH, o)
    expect([left, planned]).toEqual([1, 1])
    expect(a.voice.current()).toEqual({ room: ROOM, ch: CH })
  })

  test('passed-on frames are signed; old ones replayed are dropped once someone can confirm', async () => {
    const net = new Net()
    const [a, f, x] = ['A', 'F', 'X'].map(n => net.add(n))
    net.connect(a, f)
    const s = a.sessions.get(f.dk)!
    // F can't make up X's state: signed by a device that isn't X's it counts for nothing, and a
    // bad signature for X's device strikes.
    const now = net.clock.now()
    await s.deliver(passOn(signedBy(f, { n: now }), x.ik))
    expect(s.strikes).toBe(0)
    await s.deliver(passOn(signedBy(f, { n: now }), x.ik, { dk: x.dk }))
    expect(s.strikes).toBe(1)
    expect(inCh(a)).toEqual([])
    // A frame X signed long ago is stale when passed on.
    await s.deliver(passOn(signedBy(x, { n: 9 }), x.ik))
    expect(inCh(a)).toEqual([])
    // A recent one X really signed, passed on again: A lists X and wants a session with it.
    const t = net.clock.now()
    await s.deliver(passOn(signedBy(x, { n: t - 30_000 }), x.ik))
    await a.voice.join(ROOM, CH, { plan, muted: false })
    await net.flush()
    expect(names(net, inCh(a))).toEqual(['A', 'X'])
    expect(a.voice.keeps(x.ik)).toBe(true)
    // X never confirms on its own session: gone after confirmMs, and the next replay is ignored.
    net.connect(a, x)
    await net.step(10_000)
    expect(names(net, inCh(a))).toEqual(['A'])
    expect(a.voice.keeps(x.ik)).toBe(false)
    await s.deliver(passOn(signedBy(x, { n: t - 20_000 }), x.ik))
    expect(names(net, inCh(a))).toEqual(['A'])
    // Malformed known fields strike; unknown ones don't.
    await s.deliver(frame({ on: 'yes' }) as unknown as Message)
    expect(s.strikes).toBe(2)
    await s.deliver({ ...signedBy(f, { n: 100 }), newer: 'field' } as Message)
    expect(s.strikes).toBe(2)
    expect(names(net, inCh(a))).toEqual(['A', 'F'])
  })

  test('negotiation only with participants we connect media with', async () => {
    const net = new Net()
    const [a, b, c] = ['A', 'B', 'C'].map(n => net.add(n))
    net.mesh([a, b, c])
    await a.voice.join(ROOM, CH, { plan, muted: false })
    await b.voice.join(ROOM, CH, { plan, muted: false })
    await net.flush()
    const rtc = (to: string, ch = CH) =>
      ({ t: 'gvrtc', to, target: { p2pRoom: ROOM, ch }, payload: { muted: true } }) as Message
    await a.sessions.get(b.dk)!.deliver(rtc(a.ik))
    await a.sessions.get(c.dk)!.deliver(rtc(a.ik))
    await a.sessions.get(b.dk)!.deliver(rtc(a.ik, CH2))
    expect(names(net, a.media.signals)).toEqual(['B'])
    // Addressed to someone else: malformed for us.
    await a.sessions.get(b.dk)!.deliver(rtc(c.ik))
    expect(a.sessions.get(b.dk)!.strikes).toBe(1)
    // A's signaler sends only to participants of its channel.
    const before = net.queue.length
    a.voice.send(b.ik, { p2pRoom: ROOM, ch: CH2 }, { muted: false })
    expect(net.queue.length).toBe(before)
    a.voice.send(b.ik, { p2pRoom: ROOM, ch: CH }, { muted: false })
    expect(net.queue.length).toBe(before + 1)
  })

  test('someone whose session closes without a word is gone after lostMs, unless still heard', async () => {
    const net = new Net()
    const [a, b, c] = ['A', 'B', 'C'].map(n => net.add(n))
    net.mesh([a, b, c])
    await b.voice.join(ROOM, CH, { plan, muted: false })
    await c.voice.join(ROOM, CH, { plan, muted: false })
    await net.flush()
    expect(names(net, inCh(a))).toEqual(['B', 'C'])
    // A's session with C closes (C idles it out), but C is still heard through B: it stays.
    net.cut(a, c)
    await net.step(a.voice.limits.lostMs + 5_000)
    expect(names(net, inCh(a))).toEqual(['B', 'C'])
    // C goes away without a word: B, whose session with C closed, drops it after lostMs, also
    // though B left voice meanwhile (its timers keep running); A, who hears of C only through
    // others, when its refreshes stop for ttlMs.
    c.voice.stop()
    net.cut(b, c)
    b.voice.leave()
    await net.step(a.voice.limits.lostMs - 5_000)
    expect(names(net, inCh(b))).toEqual(['C'])
    await net.step(5_000)
    expect(inCh(b)).toEqual([])
    expect(names(net, inCh(a))).toEqual(['C'])
    await net.step(a.voice.limits.ttlMs - a.voice.limits.lostMs)
    expect(inCh(a)).toEqual([])
  })

  test('a page going away says goodbye at once, and is back only once used again', async () => {
    const net = new Net()
    const [a, b, c] = ['A', 'B', 'C'].map(n => net.add(n))
    net.connect(a, b)
    await b.voice.join(ROOM, CH, { plan, muted: false })
    await a.voice.join(ROOM, CH, { plan, muted: false })
    await net.flush()
    expect(names(net, a.media.users)).toEqual(['A', 'B'])
    b.voice.goodbye()
    await net.flush()
    expect(names(net, inCh(a))).toEqual(['A'])
    expect(names(net, a.media.users)).toEqual(['A'])
    // A slow navigation: nothing says B is in, not after seconds, not on a refresh, not to a new
    // session (which still hears whom B knows in the call).
    net.connect(b, c)
    await net.step(45_000)
    expect(names(net, inCh(a))).toEqual(['A'])
    expect(names(net, inCh(c))).toEqual(['A'])
    // The page stayed and is used again: back.
    b.voice.back()
    await net.flush()
    expect(names(net, inCh(a))).toEqual(['A', 'B'])
    expect(names(net, a.media.users)).toEqual(['A', 'B'])
    expect(names(net, inCh(c))).toEqual(['A', 'B'])
  })

  test('a refused relay tells the other side, which stops trying', async () => {
    const net = new Net()
    const [a, b, c] = ['A', 'B', 'C'].map(n => net.add(n))
    net.mesh([a, b, c])
    a.consent = () => Promise.resolve('turn.b.example')
    const told: string[] = []
    b.voice.denied = ik => told.push(ik)
    await b.voice.join(ROOM, CH, { plan: { ...plan, declared: ['turn.b.example'] }, muted: false })
    await c.voice.join(ROOM, CH, { plan, muted: false })
    await a.voice.join(ROOM, CH, { plan, muted: false })
    await net.flush()
    expect(names(net, a.media.users)).toEqual(['A', 'C'])
    // B heard: no media, no kept session and no dial to A; told why.
    expect(names(net, b.media.users)).toEqual(['B', 'C'])
    expect(b.voice.keeps(a.ik)).toBe(false)
    expect(names(net, told)).toEqual(['A'])
    net.cut(a, b)
    await net.step(1_000, 1_000)
    expect(b.voice.targets().map(t => t.ik)).toEqual([])
    expect(names(net, inCh(b))).toEqual(['A', 'B', 'C'])
    // A refusal of relays B no longer declares, or for another channel, is moot; a malformed one
    // strikes, an unknown field doesn't.
    const s = b.sessions.get(c.dk)!
    await s.deliver({ t: 'gvrefuse', room: ROOM, ch: CH, relays: ['other.example'] } as Message)
    await s.deliver({ t: 'gvrefuse', room: ROOM, ch: CH2, relays: ['turn.b.example'] } as Message)
    expect(names(net, b.media.users)).toEqual(['B', 'C'])
    await s.deliver({ t: 'gvrefuse', room: ROOM, ch: CH, relays: 'x' } as unknown as Message)
    expect(s.strikes).toBe(1)
    expect(
      readVoiceRefuse({ t: 'gvrefuse', room: ROOM, ch: CH, relays: ['turn.b.example'], later: 1 })
    ).toEqual({ t: 'gvrefuse', room: ROOM, ch: CH, relays: ['turn.b.example'] })
  })

  test('someone who loses view of the channel is gone from the lists', async () => {
    const net = new Net()
    const [a, b] = ['A', 'B'].map(n => net.add(n))
    net.connect(a, b)
    await b.voice.join(ROOM, CH, { plan, muted: false })
    await net.flush()
    expect(names(net, inCh(a))).toEqual(['B'])
    a.hidden.add(b.ik)
    await a.voice.recheck(ROOM)
    expect(inCh(a)).toEqual([])
  })

  test('at most keepMax participants hold sessions outside the budget', async () => {
    const net = new Net()
    const a = net.add('A')
    const others = ['B', 'C', 'D'].map(n => net.add(n))
    const limited = new Voice({
      ...(a.voice as unknown as { deps: ConstructorParameters<typeof Voice>[0] }).deps,
      limits: { keepMax: 2 },
    })
    limited.media = new FakeMedia()
    a.voice = limited
    for (const o of others) {
      net.connect(a, o)
      await o.voice.join(ROOM, CH, { plan, muted: false })
      await net.flush()
      await net.step(1_000, 1_000)
    }
    await limited.join(ROOM, CH, { plan, muted: false })
    expect(
      names(
        net,
        others.filter(o => limited.keeps(o.ik)).map(o => o.ik)
      )
    ).toEqual(['B', 'C'])
  })
})

describe('session budget with voice', () => {
  const held = (list: [boolean, boolean, number][]): Held[] =>
    list.map(([contact, kept, lastUseful]) => ({ contact, kept, lastUseful }))
  const small = { sessions: 4, memberSessions: 2 }

  test('below the caps nobody goes', () => {
    expect(victimFor(held([[true, false, 1]]), { contact: false, kept: false }, small)).toBe(-1)
    // Kept sessions don't count against the members' budget.
    const members = held([
      [false, false, 1],
      [false, false, 2],
    ])
    expect(victimFor(members, { contact: false, kept: true }, small)).toBe(-1)
    expect(victimFor(members, { contact: false, kept: false }, small)).toBe(0)
  })

  test('at the cap, the least useful non-voice session closes first; voice ones never', () => {
    const full = held([
      [false, true, 0],
      [true, false, 5],
      [false, false, 9],
      [true, false, 3],
    ])
    // A voice participant may push out a contact's session.
    expect(victimFor(full, { contact: false, kept: true }, small)).toBe(3)
    expect(victimFor(full, { contact: true, kept: false }, small)).toBe(3)
    // A member's session only another member's, and never a voice one.
    expect(victimFor(full, { contact: false, kept: false }, small)).toBe(2)
    const voiceOnly = held([
      [false, true, 0],
      [false, true, 1],
      [true, true, 2],
      [false, true, 3],
    ])
    expect(victimFor(voiceOnly, { contact: false, kept: true }, small)).toBeNull()
    expect(victimFor(voiceOnly, { contact: true, kept: false }, small)).toBeNull()
  })

  test('the real limits: 48 in all, 32 for members', () => {
    expect(LIMITS.sessions).toBe(48)
    const list = held(Array.from({ length: 48 }, (_, i) => [i % 2 === 0, i < 40, i]))
    expect(victimFor(list, { contact: false, kept: true })).toBe(40)
  })
})

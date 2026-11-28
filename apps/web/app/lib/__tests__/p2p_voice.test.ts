import { CallGuard } from '../client/calls'
import { testAccount } from './test_account'
import { until } from './fixtures'
import { describe, expect, test } from 'bun:test'
import { ManualClock, settle } from './p2p_net'
import { b64u, randomBytes } from '../p2p/canonical'
import type { Message } from '../p2p/frames'
import { keyId, newKeyPair, signTagged, verifyTagged, type Cert, type KeyPair } from '../p2p/keys'
import { victimFor, type Held } from '../p2p/node'
import { LOCAL } from '../p2p/limits'
import type { Clock, Session } from '../p2p/session'
import { instanceLocal } from '../p2p/user_limits'
import {
  AUDIO_TAG,
  audioBody,
  pastFit,
  readVoiceFrame,
  readVoiceRefuse,
  readVoiceRtc,
  Voice,
  VOICE_TAG,
  voiceBody,
  VoiceRoster,
  type VoiceFrame,
  type VoiceLimits,
  type VoiceMedia,
} from '../p2p/voice'
import { frameOf, known } from './helpers/frames'

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
  // What this node says about its own mic and sound.
  audio: { muted: boolean; deafened: boolean }
}

class FakeMedia implements VoiceMedia {
  users: string[] = []
  joined = false
  // A join waits for this while set.
  hold: Promise<void> | null = null
  // What frames said about participants' mics.
  noted: [string, boolean][] = []
  async join() {
    if (this.hold) await this.hold
    this.joined = true
  }
  noteMuted(user: string, muted: boolean) {
    this.noted.push([user, muted])
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
  nodes: Node[] = []
  queue: (() => Promise<unknown> | unknown)[] = []
  // Frames held back (delivered later, out of order).
  held: (() => Promise<unknown> | unknown)[] = []
  hold: ((from: Node, to: Node, m: Message) => boolean) | null = null
  // Who is a link of whom (default: every session), and members who left the room.
  linked: (a: Node, b: Node) => boolean = () => true
  out = new Set<string>()

  constructor(
    readonly clock: Clock & { advance(ms: number): Promise<void> } = new ManualClock(),
    // Frames go at once (each in a microtask) instead of waiting for `flush`.
    readonly direct = false
  ) {}

  // `as`: another device of that node's identity.
  add(name: string, as?: Node, limits?: Partial<VoiceLimits>) {
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
      audio: { muted: false, deafened: false },
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
      audio: () => node.audio,
      allowed: (_room, _ch, x) => !node.hidden.has(x),
      certs: x => ({
        ik: x,
        certs: this.nodes.filter(n => n.ik === x).map(n => ({ dk: n.dk }) as unknown as Cert),
      }),
      onChange: () => {},
      limits,
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
    else if (this.net.direct) queueMicrotask(() => void run())
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
    expect(frameOf(readVoiceFrame(frame()))).toEqual(base)
    expect(frameOf(readVoiceFrame(frame({ later: { x: 1 }, video: true })))).toEqual({
      ...base,
      video: true,
    })
    const who = ik()
    expect(known(readVoiceFrame(frame({ ik: who, relays: ['turn.example.org'] })))?.ik).toBe(who)
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
      expect(frameOf(readVoiceFrame(bad))).toBeNull()
  })

  test('negotiation frames carry only what rtc.ts knows', () => {
    const to = ik()
    const f = frameOf(
      readVoiceRtc({
        t: 'gvrtc',
        to,
        target: { p2pRoom: ROOM, ch: CH, extra: 1 },
        payload: { muted: true, sid: 'ab12', later: 'x' },
        also: true,
      })
    )
    expect(f).toEqual({
      t: 'gvrtc',
      to,
      target: { p2pRoom: ROOM, ch: CH },
      payload: { muted: true, sid: 'ab12' },
    })
    expect(
      frameOf(readVoiceRtc({ t: 'gvrtc', to, target: { p2pRoom: ROOM }, payload: {} }))
    ).toBeNull()
    expect(
      frameOf(
        readVoiceRtc({ t: 'gvrtc', to, target: { p2pRoom: ROOM, ch: CH }, payload: { muted: 1 } })
      )
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

  test('someone whose session closes without a word is gone after lostMs, unless heard', async () => {
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
      frameOf(
        readVoiceRefuse({ t: 'gvrefuse', room: ROOM, ch: CH, relays: ['turn.b.example'], later: 1 })
      )
    ).toEqual({ t: 'gvrefuse', room: ROOM, ch: CH, relays: ['turn.b.example'] })
  })

  test('a refusal reaches a participant whose session comes up after the answer', async () => {
    const net = new Net()
    const [a, b, c] = ['A', 'B', 'C'].map(n => net.add(n))
    net.connect(a, c)
    net.connect(b, c)
    const asked: string[][] = []
    a.consent = hosts => {
      asked.push(hosts)
      return Promise.resolve('turn.b.example')
    }
    const told: string[] = []
    b.voice.denied = ik => told.push(ik)
    await b.voice.join(ROOM, CH, { plan: { ...plan, declared: ['turn.b.example'] }, muted: false })
    await c.voice.join(ROOM, CH, { plan, muted: false })
    await a.voice.join(ROOM, CH, { plan, muted: false })
    await net.flush()
    expect(asked).toEqual([['turn.b.example']])
    expect(told).toEqual([])
    net.connect(a, b)
    await net.flush()
    expect(names(net, told)).toEqual(['A'])
    expect(asked.length).toBe(1)
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

  test('the list marks who is not heard and whose video is not shown', async () => {
    const net = new Net()
    const [a, b] = ['A', 'B'].map(n => net.add(n))
    const told = new Voice({
      ...(a.voice as unknown as { deps: ConstructorParameters<typeof Voice>[0] }).deps,
      rights: (_room, _ch, x) => ({ speak: x !== b.ik, video: x !== b.ik }),
    })
    told.media = new FakeMedia()
    a.voice = told
    net.connect(a, b)
    await b.voice.join(ROOM, CH, { plan, muted: false })
    b.voice.setVideo(true)
    await net.flush()
    expect(told.channels(ROOM)[CH]).toEqual([
      { ik: b.ik, video: false, muted: false, deafened: false, silenced: true, unseen: true },
    ])
    expect(b.voice.channels(ROOM)[CH]).toEqual([
      { ik: b.ik, video: true, muted: false, deafened: false },
    ])
    expect(told.rights(ROOM, CH, a.ik)).toEqual({ speak: true, video: true })
    expect(told.myRights()).toEqual({ speak: true, video: true })
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

// A clock moved by hand that runs what is due in order, each with everything it sets off (on a
// `Net` that sends at once) before the next. `watch` runs before and after each.
class QuickClock implements Clock {
  t = 1_700_000_000_000
  watch: () => void = () => {}
  private timers = new Map<number, { at: number; fn: () => void }>()
  private next = 1
  now = () => this.t
  set = (fn: () => void, ms: number) => {
    this.timers.set(this.next, { at: this.t + ms, fn })
    return this.next++
  }
  clear = (h: unknown) => void this.timers.delete(h as number)
  // Up to `ms` on, or to the end of the first timer after which `stop` holds.
  async advance(ms: number, stop: () => boolean = () => false) {
    const end = this.t + ms
    for (;;) {
      const due = [...this.timers.entries()]
        .filter(([, x]) => x.at <= end)
        .sort((x, y) => x[1].at - y[1].at)[0]
      if (!due) break
      this.timers.delete(due[0])
      this.t = Math.max(this.t, due[1].at)
      this.watch()
      due[1].fn()
      await drain()
      this.watch()
      if (stop()) return
    }
    this.t = end
  }
}

const drain = async () => {
  for (let i = 0; i < 200; i += 1) await Promise.resolve()
}

// How often B passes a quiet participant's unchanged state on: when the gap after its last pass
// ends, with gapMs past refreshMs and at least relayMs; else at the first refresh at least
// relayMs after the last pass.
const passEvery = (l: typeof LOCAL.voice) =>
  l.gapMs > l.refreshMs && l.gapMs >= l.relayMs
    ? l.gapMs
    : Math.ceil(l.relayMs / l.refreshMs) * l.refreshMs

const gcd = (x: number, y: number): number => (y ? gcd(y, x % y) : x)

// A refreshes without changing state. V hears A directly until the cut, then through B alone.
// Tied callbacks run in insertion order. Observe V on both sides of each callback so a removal
// followed by a relay at the same timestamp is visible.
const quietRun = async (
  l: typeof LOCAL.voice,
  until: number,
  cutAfter?: number,
  stopOnDrop = false
) => {
  const clock = new QuickClock()
  const net = new Net(clock, true)
  const [a, b, v] = ['A', 'B', 'V'].map(name => net.add(name, undefined, l))
  net.mesh([a, b, v])
  await a.voice.join(ROOM, CH, { plan, muted: false })
  await drain()
  const start = clock.now()
  const shown: [number, boolean][] = []
  clock.watch = () => {
    const on = inCh(v).includes(a.ik)
    if (shown.at(-1)?.[1] !== on) shown.push([clock.now() - start, on])
  }
  clock.watch()
  expect(shown).toEqual([[0, true]])
  const times: number[] = []
  const passes: number[] = []
  const toV = () =>
    (b.sessions.get(v.dk)?.sent ?? []).filter(f => (f as unknown as VoiceFrame).ik === a.ik).length
  let sent = toV()
  await clock.advance(until, () => {
    const elapsed = clock.now() - start
    times.push(elapsed)
    const count = toV()
    if (count > sent) passes.push(elapsed)
    sent = count
    return times.length === cutAfter
  })
  if (cutAfter !== undefined) {
    expect(times.length).toBe(cutAfter)
    net.cut(a, v)
    clock.watch()
    await clock.advance(l.lostMs + 4 * passEvery(l), () => stopOnDrop && shown.length > 1)
  }
  return { times, passes, shown }
}

type Swept = { cut: number; shown: [number, boolean][] }[]
const swept = new Map<string, Swept>()

// Close the session after each timer in a whole refresh/pass cycle, including the timers that
// share a timestamp. A cut that disproves a bound can finish at its first disappearance.
const quiet = async (limits: Partial<VoiceLimits>, stopOnDrop = false): Promise<Swept> => {
  const l = { ...LOCAL.voice, ...limits }
  const key = JSON.stringify(l)
  const done = swept.get(key)
  if (done) return done
  const every = passEvery(l)
  const cycle = (l.refreshMs / gcd(l.refreshMs, every)) * every
  const end = every + cycle
  const dry = await quietRun(l, end)
  expect(dry.passes.filter(t => t >= every && t < end)).toEqual(
    Array.from({ length: cycle / every }, (_, i) => (i + 1) * every)
  )
  const out: Swept = []
  for (const [i, cut] of dry.times.entries()) {
    if (cut < every || cut >= end) continue
    const { times, shown } = await quietRun(l, end, i + 1, stopOnDrop)
    expect(times.at(-1)).toBe(cut)
    out.push({ cut, shown })
  }
  if (!stopOnDrop) swept.set(key, out)
  return out
}

const dropped = (runs: Swept) => runs.filter(({ shown }) => shown.some(([, on]) => !on))

describe('a quiet participant heard through others', () => {
  // The voice limits a device takes from an instance that gives these.
  const device = (given: Partial<VoiceLimits>) => {
    const p2p = Object.fromEntries(Object.entries(given).map(([k, x]) => [`local.voice.${k}`, x]))
    return instanceLocal({ limits: { p2p } }).voice
  }

  test('stays shown with every voice refresh rule at its edge, wherever the session closes', async () => {
    for (const given of [
      {},
      { refreshMs: 30_000, lostMs: 35_000 },
      { relayMs: 30_000, lostMs: 50_000 },
      { lostMs: 25_000 },
      { refreshMs: 5000, relayMs: 5001, ttlMs: 15_000, lostMs: 10_001 },
      { gapMs: 999, refreshMs: 5000, relayMs: 1000, ttlMs: 15_000, lostMs: 6000 },
      { refreshMs: 240_000, relayMs: 60_000, ttlMs: 480_000, lostMs: 300_000, tickMs: 60_000 },
      { gapMs: 9999 },
      { gapMs: 25_000, lostMs: 45_001 },
      { gapMs: 7500, refreshMs: 5000, relayMs: 1000, ttlMs: 15_000, lostMs: 12_501 },
      { gapMs: 9000, refreshMs: 5000, relayMs: 1000, ttlMs: 18_000, lostMs: 14_001 },
      { gapMs: 15_000, refreshMs: 5000, relayMs: 1000, ttlMs: 30_000, lostMs: 20_001 },
      { gapMs: 7000, refreshMs: 5000, relayMs: 12_000, ttlMs: 30_000, lostMs: 17_000 },
      { gapMs: 30_000, refreshMs: 5000, relayMs: 30_000, ttlMs: 60_000, lostMs: 35_001 },
      { gapMs: 30_000, refreshMs: 5000, relayMs: 30_000, ttlMs: 60_000, lostMs: 60_000 },
    ]) {
      expect(device(given)).toEqual({ ...LOCAL.voice, ...given })
      const runs = await quiet(given)
      expect(runs.length).toBeGreaterThan(3)
      expect([given, dropped(runs)]).toEqual([given, []])
    }
  }, 300_000)

  test('a loss timer tied with a newer relay can run first', async () => {
    const given = { gapMs: 30_000, refreshMs: 5000, relayMs: 30_000, ttlMs: 60_000, lostMs: 35_000 }
    expect(dropped(await quiet(given))).toEqual([
      {
        cut: 55_000,
        shown: [
          [0, true],
          [90_000, false],
          [90_000, true],
        ],
      },
    ])
    expect(device(given)).not.toEqual({ ...LOCAL.voice, ...given })
  }, 60_000)

  test('the roster can expire before the loss timer fires', async () => {
    const given = { gapMs: 30_000, refreshMs: 5000, ttlMs: 15_000, lostMs: 300_000 }
    const runs = await quiet(given, true)
    expect(
      runs.some(({ cut, shown }) => shown.some(([at, on]) => !on && at < cut + given.lostMs))
    ).toBe(true)
    expect(dropped(await quiet(device(given)))).toEqual([])
  }, 60_000)

  test('drops out past an edge, and stays shown on what the device makes of those values', async () => {
    // With more than lostMs to the next refresh, A disappears at loss and returns at that refresh.
    const runs = await quiet({ lostMs: 10_000 })
    for (const { cut, shown } of runs) {
      const next = (Math.floor(cut / 20_000) + 1) * 20_000
      expect(shown).toEqual(
        cut + 10_000 < next
          ? [
              [0, true],
              [cut + 10_000, false],
              [next, true],
            ]
          : [[0, true]]
      )
    }
    expect(dropped(runs).length).toBeGreaterThan(0)
    for (const given of [
      { lostMs: 10_000 },
      { refreshMs: 5000, relayMs: 5001, ttlMs: 15_000, lostMs: 9000 },
      { refreshMs: 21_000, relayMs: 42_001, lostMs: 300_000 },
      { refreshMs: 120_000, lostMs: 300_000 },
      { gapMs: 30_000, lostMs: 25_000 },
      { gapMs: 29_000, relayMs: 1000, lostMs: 28_500 },
      { gapMs: 25_000 },
      { gapMs: 30_000, lostMs: 35_000 },
      { gapMs: 29_000, relayMs: 1000, lostMs: 30_000 },
      { gapMs: 7500, refreshMs: 5000, relayMs: 1000, ttlMs: 15_000, lostMs: 8500 },
      { gapMs: 9000, refreshMs: 5000, relayMs: 1000, ttlMs: 18_000, lostMs: 12_000 },
      { gapMs: 15_000, refreshMs: 5000, relayMs: 1000, ttlMs: 30_000, lostMs: 20_000 },
    ]) {
      expect([given, dropped(await quiet(given, true)).length > 0]).toEqual([given, true])
      expect(device(given)).not.toEqual({ ...LOCAL.voice, ...given })
      expect([given, dropped(await quiet(device(given)))]).toEqual([given, []])
    }
  }, 300_000)
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
    expect(LOCAL.node.sessions).toBe(48)
    const list = held(Array.from({ length: 48 }, (_, i) => [i % 2 === 0, i < 40, i]))
    expect(victimFor(list, { contact: false, kept: true })).toBe(40)
  })
})

test('a voice channel joins only after its identity acquires the call and releases when it leaves', async () => {
  const guard = new CallGuard()
  const account = testAccount('test')
  const net = new Net()
  const a = net.add('A')
  await guard.request({ account, kind: 'dm' }, () => {})
  a.voice.claim = (leave, valid) =>
    guard.request({ account, identity: a.ik, kind: 'p2p-voice' }, leave, valid)
  const joining = a.voice.join(ROOM, CH, { plan, muted: false })
  await until(() => account.store.getState().confirm !== null)
  expect(a.media.joined).toBe(false)
  account.store.getState().confirm!.action('')
  await joining
  expect(guard.current()?.identity).toBe(a.ik)
  expect(a.media.joined).toBe(true)
  a.voice.leave()
  expect(guard.current()).toBeNull()
})

describe('what participants say about their audio', () => {
  // A frame about `who` with what it says about its audio, signed by its device.
  const withAudio = (
    who: Node,
    flags: { m?: true; d?: true },
    over: Partial<VoiceFrame> = {}
  ): Message => {
    const f = signedBy(who, over) as unknown as VoiceFrame
    const sig = signTagged(who.dkKey.sk, AUDIO_TAG, audioBody({ ...f, aud: flags }, who.ik))
    return { ...f, aud: { ...flags, sig } } as unknown as Message
  }
  const userIn = (n: Node, of: Node, ch = CH) =>
    n.voice.channels(ROOM)[ch]?.find(u => u.ik === of.ik)
  const gvoice = (s: FakeSession) => s.sent.filter(m => m.t === 'gvoice') as unknown as VoiceFrame[]

  test('it is signed apart from the frame, verified and shown', async () => {
    const net = new Net()
    const [a, b] = ['A', 'B'].map(n => net.add(n))
    net.connect(a, b)
    await b.voice.join(ROOM, CH, { plan, muted: false })
    a.audio = { muted: true, deafened: false }
    await a.voice.join(ROOM, CH, { plan, muted: true })
    await net.flush()
    expect(b.voice.heardMuted(a.ik)).toBe(true)
    expect(b.media.noted.at(-1)).toEqual([a.ik, true])
    const f = gvoice(a.sessions.get(b.dk)!).at(-1)!
    expect(f.aud?.m).toBe(true)
    expect(f.aud?.d).toBeUndefined()
    expect(verifyTagged(a.dk, AUDIO_TAG, audioBody(f, a.ik), f.aud?.sig)).toBe(true)
    expect(userIn(b, a)).toEqual({ ik: a.ik, video: false, muted: true, deafened: false })
    expect(userIn(a, a)).toEqual({ ik: a.ik, video: false, muted: true, deafened: false })
    a.audio = { muted: false, deafened: false }
    a.voice.setAudio()
    await net.flush()
    expect(gvoice(a.sessions.get(b.dk)!).at(-1)?.aud).toBeUndefined()
    expect(userIn(b, a)?.muted).toBe(false)
    expect(b.sessions.get(a.dk)!.strikes).toBe(0)
  })

  test('a reader that knows only the frame verifies one that carries it', () => {
    const net = new Net()
    const a = net.add('A')
    const m = withAudio(a, { m: true, d: true }, { n: 7 }) as unknown as VoiceFrame
    // What a peer without `aud` keeps of the frame and checks: the known fields under VOICE_TAG.
    const { aud, ...older } = m
    expect(voiceBody(m, a.ik)).toEqual(voiceBody(older, a.ik))
    expect(verifyTagged(a.dk, VOICE_TAG, voiceBody(older, a.ik), older.sig)).toBe(true)
    expect(known(readVoiceFrame(m))?.aud).toEqual(aud)
    expect(known(readVoiceFrame(older))?.aud).toBeUndefined()
  })

  test('a malformed one is dropped alone, without a strike', async () => {
    const net = new Net()
    const [a, f] = ['A', 'F'].map(n => net.add(n))
    net.connect(a, f)
    const s = a.sessions.get(f.dk)!
    const t = net.clock.now()
    const bad = [
      { m: 'yes', sig: SIG },
      { m: true },
      'muted',
      { d: 1, sig: SIG },
      { m: true, sig: 'short' },
    ]
    for (const [i, aud] of bad.entries()) {
      expect(frameOf(readVoiceFrame(frame({ aud })))).toEqual(frameOf(readVoiceFrame(frame())))
      await s.deliver({ ...withAudio(f, { m: true }, { n: t + i }), aud } as Message)
      expect(userIn(a, f)).toEqual({ ik: f.ik, video: false, muted: false, deafened: false })
    }
    expect(s.strikes).toBe(0)
    const extra = { ...withAudio(f, { d: true }, { n: t + 9 }) } as unknown as VoiceFrame
    await s.deliver({ ...extra, aud: { ...extra.aud, later: 1 } } as unknown as Message)
    expect(userIn(a, f)?.deafened).toBe(true)
    expect(s.strikes).toBe(0)
  })

  test('a bad signature strikes, and the frame stands without it', async () => {
    const net = new Net()
    const [a, f] = ['A', 'F'].map(n => net.add(n))
    net.connect(a, f)
    const s = a.sessions.get(f.dk)!
    const t = net.clock.now()
    await s.deliver({ ...signedBy(f, { n: t + 1 }), aud: { m: true, sig: SIG } } as Message)
    expect(s.strikes).toBe(1)
    expect(names(net, inCh(a))).toEqual(['F'])
    expect(userIn(a, f)?.muted).toBe(false)
    // One signed for an earlier stamp doesn't verify on a newer frame.
    const earlier = withAudio(f, { m: true }, { n: t + 2 })
    await s.deliver(earlier)
    expect(userIn(a, f)?.muted).toBe(true)
    const moved = (earlier as unknown as VoiceFrame).aud
    await s.deliver({ ...signedBy(f, { n: t + 3 }), aud: moved } as Message)
    expect(s.strikes).toBe(2)
    expect(userIn(a, f)?.muted).toBe(false)
  })

  test('a relay passes it on as it came', async () => {
    const net = new Net()
    const [f, r, l] = ['F', 'R', 'L'].map(n => net.add(n))
    net.connect(f, r)
    net.connect(r, l)
    const fromF = r.sessions.get(f.dk)!
    const toL = r.sessions.get(l.dk)!
    const m = withAudio(f, { m: true, d: true }, { n: net.clock.now() + 1 })
    await fromF.deliver(m)
    await net.flush()
    const passed = toL.sent.filter(x => x.t === 'gvoice' && x.ik === f.ik)
    expect(passed.length).toBe(1)
    expect(passed[0].aud).toEqual(m.aud)
    expect(userIn(l, f)).toEqual({ ik: f.ik, video: false, muted: true, deafened: true })
    expect(l.sessions.get(r.dk)!.strikes).toBe(0)
    // A change of audio alone goes on too, once the gap is over.
    await fromF.deliver(signedBy(f, { n: net.clock.now() + 2 }))
    await net.step(1_000, 1_000)
    expect(toL.sent.filter(x => x.t === 'gvoice' && x.ik === f.ik).length).toBe(2)
    expect(userIn(l, f)?.muted).toBe(false)
  })

  test('changes go one per gap, the latest last', async () => {
    const net = new Net()
    const [a, b] = ['A', 'B'].map(n => net.add(n))
    net.connect(a, b)
    await a.voice.join(ROOM, CH, { plan, muted: false })
    await net.flush()
    const toB = a.sessions.get(b.dk)!
    const before = gvoice(toB).length
    const say = (muted: boolean, deafened: boolean) => {
      a.audio = { muted, deafened }
      a.voice.setAudio()
    }
    say(true, false)
    say(true, true)
    say(true, false)
    say(true, true)
    await net.flush()
    expect(gvoice(toB).length).toBe(before + 1)
    expect(userIn(b, a)).toEqual({ ik: a.ik, video: false, muted: true, deafened: false })
    await net.step(1_000, 1_000)
    expect(gvoice(toB).length).toBe(before + 2)
    expect(userIn(b, a)).toEqual({ ik: a.ik, video: false, muted: true, deafened: true })
    // Off and on again within a gap says nothing new.
    say(true, false)
    say(true, true)
    await net.step(1_000, 1_000)
    expect(gvoice(toB).length).toBe(before + 2)
    a.voice.leave()
    say(false, false)
    await net.step(1_000, 1_000)
    expect(gvoice(toB).at(-1)?.on).toBe(false)
  })

  test('a change made while joining goes in the join frame', async () => {
    const net = new Net()
    const [a, b] = ['A', 'B'].map(n => net.add(n))
    net.connect(a, b)
    let open = () => {}
    a.media.hold = new Promise(r => (open = r))
    const joining = a.voice.join(ROOM, CH, { plan, muted: false })
    await until(() => a.voice.current() !== null)
    a.audio = { muted: true, deafened: true }
    a.voice.setAudio()
    await net.flush()
    const toB = a.sessions.get(b.dk)!
    expect(gvoice(toB)).toEqual([])
    open()
    await joining
    await net.flush()
    expect(gvoice(toB).map(f => [f.on, f.aud?.m, f.aud?.d])).toEqual([[true, true, true]])
    expect(userIn(b, a)).toEqual({ ik: a.ik, video: false, muted: true, deafened: true })
  })

  test('one moved into another room or channel strikes', async () => {
    const net = new Net()
    const [a, f] = ['A', 'F'].map(n => net.add(n))
    net.connect(a, f)
    const s = a.sessions.get(f.dk)!
    const t = net.clock.now()
    const signed = withAudio(f, { m: true }, { n: t + 1 }) as unknown as VoiceFrame
    const otherRoom = b64u(randomBytes(32))
    await s.deliver({ ...signedBy(f, { n: t + 1, ch: CH2 }), aud: signed.aud } as Message)
    expect(s.strikes).toBe(1)
    expect(userIn(a, f, CH2)?.muted).toBe(false)
    await s.deliver({ ...signedBy(f, { n: t + 1, room: otherRoom }), aud: signed.aud } as Message)
    expect(s.strikes).toBe(2)
    await s.deliver(withAudio(f, { m: true }, { n: t + 2 }))
    expect(s.strikes).toBe(2)
    expect(userIn(a, f, CH)?.muted).toBe(true)
  })

  test('a change that could not be signed goes once it can', async () => {
    const net = new Net()
    const [a, b] = ['A', 'B'].map(n => net.add(n))
    net.connect(a, b)
    await a.voice.join(ROOM, CH, { plan, muted: false })
    await net.flush()
    const deps = (a.voice as unknown as { deps: { signer: () => unknown } }).deps
    const signer = deps.signer
    deps.signer = () => null
    a.audio = { muted: true, deafened: false }
    a.voice.setAudio()
    await net.flush()
    expect(userIn(b, a)?.muted).toBe(false)
    deps.signer = signer
    await net.step(1_000, 1_000)
    a.voice.setAudio()
    await net.flush()
    expect(userIn(b, a)?.muted).toBe(true)
  })
})

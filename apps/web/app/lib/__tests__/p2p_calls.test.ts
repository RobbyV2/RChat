import { afterEach, describe, expect, test } from 'bun:test'
import { Hub, makeNode, ManualClock, settle, waitFor } from './p2p_net'
import { LIMITS, P2pNode, victimFor, type Visibility } from '../p2p/node'
import { P2pStore, type SelfRecord } from '../p2p/db'
import { Dms, dmRoomId, loadMessages, withMissed, type MissedCall } from '../p2p/dm'
import {
  BUSY_TEXT,
  BYE_MS,
  Calls,
  RING_GRACE_MS,
  RING_MS,
  RINGS_PER_MIN,
  UNKNOWN_PER_MIN,
  type CallMedia,
  type CallPlan,
  type PendingCall,
} from '../p2p/calls'
import { P2pSignaler, readCallFrame, readRtcFrame, type RtcFrame } from '../p2p/signal'
import { decodeMessage, encodeMessage, type Message } from '../p2p/frames'
import { checkContent, type CallContent } from '../p2p/event'
import { RtcManager, wsSignaler, type RtcTarget, type Signaler } from '../rtc'
import { sameScope, type SignalScope } from '../negotiation'
import { DENIED_CALL } from '../relays'
import type { RtcPayload, VoiceMsg } from '../types'
import type { Session } from '../p2p/session'
import { keyId, newKeyPair, signCert, signRevocation } from '../p2p/keys'

// Well-formed ids: a room (32 bytes) and a call (16 bytes), b64u.
const ROOM_X = 'r'.repeat(42) + 'A'
const ROOM_Y = 's'.repeat(42) + 'A'
const CALL_X = 'c'.repeat(21) + 'A'
const BOB = keyId(newKeyPair().pk)

// ----- The signaler contract -----

// What reaches the other side's onSignal for one send.
interface Delivered {
  from: string
  payload: RtcPayload
  scope: SignalScope
}

// Each implementation with the path a payload takes to the other side: the instance's through
// the server's rtc_signal relay, the P2P one as an encrypted-session message.
const implementations: {
  name: string
  target: RtcTarget
  other: RtcTarget
  make: (deliver: (d: Delivered) => void) => Signaler
}[] = [
  {
    name: 'instance (rtc_signal over the WS)',
    target: { dmId: 7 },
    other: { channelId: 7 },
    make: deliver =>
      wsSignaler((msg: VoiceMsg) => {
        if (msg.type !== 'rtc_signal') return false
        // The server relays it as is, naming the sender.
        const ev = JSON.parse(JSON.stringify({ ...msg, from: 'alice' })) as typeof msg & {
          from: string
        }
        deliver({
          from: ev.from,
          payload: ev.payload,
          scope: { channelId: ev.channel_id, dmId: ev.dm_id },
        })
        return true
      }),
  },
  {
    name: 'P2P (rtc frame over the session)',
    target: { p2pRoom: ROOM_X },
    other: { p2pRoom: ROOM_Y },
    make: deliver =>
      new P2pSignaler(
        () => CALL_X,
        (_to, frame) => {
          const wire = decodeMessage(encodeMessage(frame as unknown as Message))
          const f = readRtcFrame(wire)
          if (f) deliver({ from: 'alice', payload: f.payload, scope: f.target })
        }
      ),
  },
]

const payloads: RtcPayload[] = [
  { description: { type: 'offer', sdp: 'v=0\r\no=- 1 2 IN IP4 127.0.0.1\r\n' }, sid: 'ab12' },
  { description: { type: 'answer', sdp: 'v=0\r\n' }, sid: 'cd34', rsid: 'ab12' },
  {
    candidate: {
      candidate: 'candidate:1 1 udp 2122260223 10.0.0.2 51000 typ host',
      sdpMid: '0',
      sdpMLineIndex: 0,
      usernameFragment: 'u1',
    },
    sid: 'ab12',
  },
  { muted: true, cam: false, screen: true, sid: 'ab12' },
  { restart: true, sid: 'ab12', rsid: 'cd34' },
]

describe('signaler contract', () => {
  for (const impl of implementations)
    test(impl.name, () => {
      const got: Delivered[] = []
      const s = impl.make(d => got.push(d))
      for (const p of payloads) s.send(BOB, impl.target, p)
      expect(got.map(g => g.payload)).toEqual(payloads)
      for (const g of got) {
        expect(g.from).toBe('alice')
        // The receiving side scopes it to the session it was sent for, and only that one.
        expect(sameScope(impl.target, g.scope)).toBe(true)
        expect(sameScope(impl.other, g.scope)).toBe(false)
      }
    })

  test('the instance manager still sends rtc_signal through the WS', () => {
    const sent: VoiceMsg[] = []
    const m = new RtcManager({ send: msg => sent.push(msg) })
    const s = (m as unknown as { signaler: Signaler }).signaler
    s.send('bob', { dmId: 3 }, { muted: true })
    expect(sent).toEqual([
      { type: 'rtc_signal', to: 'bob', channel_id: null, dm_id: 3, payload: { muted: true } },
    ])
  })

  test('the P2P signaler sends nothing outside a call or for an instance target', () => {
    const out: RtcFrame[] = []
    let call: string | null = null
    const s = new P2pSignaler(
      () => call,
      (_to, f) => out.push(f)
    )
    s.send('bob', { p2pRoom: ROOM_X }, { muted: true })
    call = CALL_X
    s.send('bob', { dmId: 3 }, { muted: true })
    expect(out).toEqual([])
  })
})

// ----- Frames -----

describe('call frames', () => {
  const room = ROOM_X
  const id = CALL_X
  const ik = keyId(newKeyPair().pk)

  test('rtc frames round trip as session messages and refuse malformed known fields', () => {
    for (const payload of payloads) {
      const f: RtcFrame = { t: 'rtc', to: ik, target: { p2pRoom: room }, call: id, payload }
      expect(readRtcFrame(decodeMessage(encodeMessage(f as unknown as Message)))).toEqual(f)
    }
    const ok = { t: 'rtc', to: ik, target: { p2pRoom: room }, call: id, payload: payloads[0] }
    // Forward compatibility: fields a newer version adds, at any level, are dropped.
    const newer = {
      ...ok,
      extra: 1,
      target: { p2pRoom: room, dmId: 3 },
      payload: {
        description: { type: 'offer', sdp: 'v=0', simulcast: true },
        candidate: { candidate: 'c', sdpMid: '0', priority: 5 },
        muted: true,
        hold: true,
        sid: 'ab',
      },
    }
    expect(readRtcFrame(newer)).toEqual({
      t: 'rtc',
      to: ik,
      target: { p2pRoom: room },
      call: id,
      payload: {
        description: { type: 'offer', sdp: 'v=0' },
        candidate: { candidate: 'c', sdpMid: '0' },
        muted: true,
        sid: 'ab',
      },
    })
    const bad: unknown[] = [
      { ...ok, to: 'bob' },
      { ...ok, call: 'short' },
      { ...ok, target: { dmId: 3 } },
      { ...ok, payload: undefined },
      { ...ok, payload: { description: { type: 'offer', sdp: 'x'.repeat(100_001) } } },
      { ...ok, payload: { description: { type: 'bogus', sdp: '' } } },
      { ...ok, payload: { candidate: { candidate: 1 } } },
      { ...ok, payload: { muted: 'yes' } },
      { ...ok, payload: { sid: '<script>' } },
    ]
    for (const b of bad) expect(readRtcFrame(b)).toBeNull()
  })

  test('call frames: ops, video on rings, relays read on ring and accept', () => {
    expect(readCallFrame({ t: 'call', op: 'ring', id, room, video: true })).toEqual({
      t: 'call',
      op: 'ring',
      id,
      room,
      video: true,
    })
    expect(
      readCallFrame({ t: 'call', op: 'accept', id, room, relays: ['turn.example.com'] })
    ).toEqual({ t: 'call', op: 'accept', id, room, relays: ['turn.example.com'] })
    // Fields a newer version adds, and fields this one doesn't read for that op, are dropped.
    expect(
      readCallFrame({ t: 'call', op: 'end', id, room, video: true, relays: ['x!'], more: 1 })
    ).toEqual({ t: 'call', op: 'end', id, room })
    // An op a newer version adds is recognised as such (dropped, not struck).
    expect(readCallFrame({ t: 'call', op: 'hold', id, room, until: 5 })).toBe('unknown')
    for (const b of [
      { t: 'call', op: 'ring', id, room },
      { t: 'call', op: 7, id, room },
      { t: 'call', op: 'hold', id: 'x', room },
      { t: 'call', op: 'hold', id, room: 'x' },
      { t: 'call', op: 'ring', id, room, video: 'yes' },
      { t: 'call', op: 'ring', id, room, video: false, relays: ['bad host!'] },
      {
        t: 'call',
        op: 'ring',
        id,
        room,
        video: false,
        relays: ['a.com', 'b.com', 'c.com', 'd.com', 'e.com'],
      },
      { t: 'call', op: 'end', id: 'x', room },
    ])
      expect(readCallFrame(b)).toBeNull()
  })

  test('call log content', () => {
    const ok: CallContent[] = [
      { id, video: false, outcome: 'ended', dur: 0 },
      { id, video: true, outcome: 'ended', dur: 3600 },
      { id, video: false, outcome: 'missed' },
      { id, video: true, outcome: 'declined' },
      // From a newer version: an extra field, an outcome kept but not shown.
      { id, video: false, outcome: 'missed', body: 'x' } as CallContent,
      { id, video: false, outcome: 'busy' } as unknown as CallContent,
      { id, video: false, outcome: 'missed', dur: 3 },
    ]
    for (const c of ok) expect(checkContent('call', c)).toBe(true)
    for (const c of [
      { id, video: false, outcome: 'ended' },
      { id, video: false, outcome: 'ended', dur: -1 },
      { id, video: false, outcome: 'ended', dur: 1.5 },
      { id, video: false, outcome: 'ended', dur: 8 * 24 * 3600 },
      { id, video: 'no', outcome: 'missed' },
      { id: 'short', video: false, outcome: 'missed' },
      { id, video: false, outcome: 'Busy!' },
      { id, video: false },
    ])
      expect(checkContent('call', c)).toBe(false)
  })
})

// ----- Calls between two nodes -----

class FakeMedia implements CallMedia {
  target: RtcTarget | null = null
  synced: string[] = []
  signals: Delivered[] = []
  left = 0
  async join(_me: string, target: RtcTarget) {
    this.target = target
  }
  sync(users: string[]) {
    this.synced = users
  }
  leave() {
    this.target = null
    this.synced = []
    this.left += 1
  }
  async onSignal(from: string, payload: RtcPayload, scope: SignalScope) {
    this.signals.push({ from, payload, scope })
  }
}

interface Peer {
  node: P2pNode
  store: P2pStore
  dms: Dms
  calls: Calls
  media: FakeMedia
  logs: CallContent[]
  missed: MissedCall[]
  notices: string[]
  pending: PendingCall | null
  consented: string[][]
  opts: PeerOpts
}

interface PeerOpts {
  visibility?: Visibility
  declared?: string[]
  relayOnly?: boolean
  consent?: (hosts: string[]) => Promise<string | null>
  busy?: boolean
  mutual?: boolean
}

const live: Peer[] = []
const extra: P2pNode[] = []
afterEach(() => {
  for (const n of extra.splice(0)) n.stop()
  for (const p of live.splice(0)) {
    p.calls.stop()
    p.dms.stop()
    p.node.stop()
  }
})

const planOf = (o: PeerOpts): CallPlan => ({
  ok: true,
  config: o.relayOnly ? { iceServers: [], iceTransportPolicy: 'relay' } : { iceServers: [] },
  declared: o.declared ?? [],
  manual: null,
})

const makePeer = async (hub: Hub, name: string, clock: ManualClock, opts: PeerOpts = {}) => {
  const n = await makeNode(hub, name, { clock, visibility: opts.visibility })
  const dms = new Dms({ node: n.node, store: n.store, clock })
  const media = new FakeMedia()
  const p = {
    ...n,
    dms,
    media,
    logs: [],
    missed: [],
    notices: [],
    pending: null,
    consented: [],
    opts,
  } as unknown as Peer
  p.calls = new Calls({
    me: () => n.node.ik,
    sessions: ik => n.node.readySessions(ik),
    mutual: ik => p.opts.mutual !== false && n.node.contact(ik)?.state === 'mutual',
    roomOf: ik => dmRoomId(n.node.ik, ik),
    name: () => name,
    media,
    plan: async () => planOf(p.opts),
    hidesIp: plan => plan.config.iceTransportPolicy === 'relay',
    consent: hosts => {
      p.consented.push(hosts)
      return p.opts.consent ? p.opts.consent(hosts) : Promise.resolve(null)
    },
    log: async (room, call) => {
      p.logs.push(call)
      await dms.logCall(room, call)
    },
    missed: (_room, m) => p.missed.push(m),
    busy: () => p.opts.busy === true,
    muted: () => false,
    save: x => (p.pending = x),
    notice: t => p.notices.push(t),
    clock,
  })
  n.node.use({
    attach: s => p.calls.attach(s),
    ready: s => p.calls.ready(s),
    keep: s => p.calls.keeps(s),
    awake: () => p.calls.awake(),
  })
  live.push(p)
  return p
}

const linked = (a: Peer, b: Peer) =>
  a.dms.online(a.dms.roomFor(b.node.ik)) && b.dms.online(b.dms.roomFor(a.node.ik))

const pair = async (ao: PeerOpts = {}, bo: PeerOpts = {}) => {
  const clock = new ManualClock()
  const hub = new Hub()
  const a = await makePeer(hub, 'Alice', clock, ao)
  const b = await makePeer(hub, 'Bob', clock, bo)
  await a.node.start()
  await b.node.start()
  await a.node.addContact(await b.node.myCard())
  await waitFor(() => b.node.contact(a.node.ik)?.state === 'incoming', 'request')
  await b.node.accept(a.node.ik)
  await waitFor(() => linked(a, b), 'sync links')
  await a.dms.open(b.node.ik)
  await b.dms.open(a.node.ik)
  return { clock, hub, a, b, room: dmRoomId(a.node.ik, b.node.ik) }
}

const sessionOf = (p: Peer, other: Peer) => p.node.readySessions(other.node.ik)[0] as Session

// Resolves once `to` has handled everything `from` sent before (sessions keep their order), so
// a test can then check what did not happen.
let marks = 0
const drained = async (from: Session, to: Session) => {
  const mark = `t_mark${(marks += 1)}`
  let seen = false
  to.on(mark, () => {
    seen = true
  })
  await from.send({ t: mark })
  await waitFor(() => seen, 'frames handled')
}

// Every frame `p` sends from now on looks like it came from a newer version: extra fields on
// `call` and `rtc` frames and in their payloads.
const newer = (p: Peer, other: Peer) => {
  const s = sessionOf(p, other)
  const send = s.send.bind(s)
  s.send = (m: Message) =>
    send(
      m.t === 'call'
        ? { ...m, prio: 1 }
        : m.t === 'rtc'
          ? { ...m, seq: 3, payload: { ...(m.payload as object), hold: true } }
          : m
    )
  return s
}

// A second device of `p`'s identity whose hello revokes `p`'s device (a move to a phone).
const revokeBy = async (p: Peer, hub: Hub, clock: ManualClock, other: Peer) => {
  const self = (p.node as unknown as { self: SelfRecord }).self
  const dk2 = newKeyPair()
  const cert2 = signCert(self.ik, dk2.pk, clock.now(), 'Phone')
  const rev = signRevocation(self.ik, p.node.dk, clock.now(), keyId(dk2.pk))
  const phone = await P2pStore.open(`phone-${Math.random()}`)
  await phone.putSelf({ ...self, dk: dk2, cert: cert2, certs: [cert2], revocations: [rev] })
  await phone.putContact((await p.store.contact(other.node.ik))!)
  const p2 = (await P2pNode.open({
    store: phone,
    transport: hub.transport(),
    host: 'chat.example',
    clock,
  })) as P2pNode
  extra.push(p2)
  await p2.start()
  p2.schedule(true)
  return p2
}

const rows = async (p: Peer, other: Peer) =>
  (
    await loadMessages(p.store.db, p.dms.roomFor(other.node.ik), p.node.ik, other.node.ik, {
      limit: 1000,
    })
  ).messages

const callRows = async (p: Peer, other: Peer) =>
  (await rows(p, other)).flatMap(m => (m.call ? [{ ...m.call, sender: m.sender }] : []))

const eventually = async (ok: () => Promise<boolean>, what: string, ms = 15_000) => {
  const end = Date.now() + ms
  while (!(await ok())) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`)
    await new Promise(r => setTimeout(r, 2))
  }
}

const failure = (p: Promise<unknown>) =>
  p.then(
    () => 'ok',
    (e: Error) => e.message
  )

const ringing = async (a: Peer, b: Peer, video = false) => {
  await a.calls.start(b.node.ik, video)
  await waitFor(() => b.calls.view()?.state === 'ringing', 'ringing')
}

const answered = async (a: Peer, b: Peer) => {
  await ringing(a, b)
  await b.calls.accept()
  await waitFor(() => a.calls.view()?.state === 'active', 'answered')
}

describe('P2P calls', () => {
  test('voice call: ring, answer, negotiation both ways, hang up logs the length', async () => {
    const { clock, a, b, room } = await pair()
    await ringing(a, b, true)
    expect(a.media.target).toEqual({ p2pRoom: room })
    expect(b.media.target).toBeNull()
    const ring = b.calls.view()
    expect(ring).toMatchObject({ dir: 'in', state: 'ringing', video: true, peer: a.node.ik, room })
    expect(a.pending).toMatchObject({ room, answeredAt: null })
    await b.calls.accept()
    await waitFor(() => a.calls.view()?.state === 'active', 'answered')
    expect(b.media.synced).toEqual([b.node.ik, a.node.ik])
    expect(a.media.synced).toEqual([a.node.ik, b.node.ik])
    // SDP and candidates go over the session, to the other side's media, in this call's scope.
    const offer: RtcPayload = { description: { type: 'offer', sdp: 'v=0\r\n' }, sid: 'aa11' }
    a.calls.signaler.send(b.node.ik, { p2pRoom: room }, offer)
    const answer: RtcPayload = { description: { type: 'answer', sdp: 'v=0\r\n' }, sid: 'bb22' }
    b.calls.signaler.send(a.node.ik, { p2pRoom: room }, answer)
    await waitFor(() => b.media.signals.length === 1 && a.media.signals.length === 1, 'signals')
    expect(b.media.signals[0]).toEqual({
      from: a.node.ik,
      payload: offer,
      scope: { p2pRoom: room },
    })
    expect(a.media.signals[0].payload).toEqual(answer)
    expect(sessionOf(a, b).strikes + sessionOf(b, a).strikes).toBe(0)
    await clock.advance(12_000)
    expect(a.pending?.answeredAt).not.toBeNull()
    a.calls.hangup()
    await waitFor(() => b.calls.view() === null, 'ended on the other side')
    expect(a.media.left).toBe(1)
    expect(b.media.left).toBe(1)
    expect(a.logs).toEqual([{ id: ring?.id as string, video: true, outcome: 'ended', dur: 12 }])
    expect(a.pending).toBeNull()
    // The caller's row reaches the callee and reads the same on both sides.
    await eventually(async () => (await callRows(b, a)).length === 1, 'row synced')
    for (const [p, q] of [
      [a, b],
      [b, a],
    ])
      expect(await callRows(p, q)).toEqual([
        { id: ring?.id as string, video: true, outcome: 'ended', dur: 12, sender: a.node.ik },
      ])
  }, 60_000)

  test('a phone tab hidden past the pause keeps an answered call; idle, it pauses', async () => {
    let visible = true
    const fns = new Set<() => void>()
    const visibility: Visibility = {
      visible: () => visible,
      onChange: fn => {
        fns.add(fn)
        return () => fns.delete(fn)
      },
      pauses: () => true,
    }
    const { clock, a, b } = await pair({ visibility })
    await answered(a, b)
    visible = false
    fns.forEach(f => f())
    await clock.advance(LIMITS.hiddenPauseMs + 30_000)
    await settle()
    expect(a.node.status).toBe('online')
    expect(a.calls.view()?.state).toBe('active')
    expect(b.calls.view()?.state).toBe('active')
    a.calls.hangup()
    await waitFor(() => b.calls.view() === null, 'ended')
    await clock.advance(LIMITS.hiddenPauseMs + 1000)
    await waitFor(() => a.node.status === 'paused', 'paused once the call ended')
  }, 60_000)

  test('a computer tab hidden for long keeps its sessions', async () => {
    let visible = true
    const fns = new Set<() => void>()
    const visibility: Visibility = {
      visible: () => visible,
      onChange: fn => {
        fns.add(fn)
        return () => fns.delete(fn)
      },
      pauses: () => false,
    }
    const { clock, a, b } = await pair({ visibility })
    visible = false
    fns.forEach(f => f())
    await clock.advance(3 * LIMITS.hiddenPauseMs)
    await settle()
    expect(a.node.status).toBe('online')
    expect(a.node.presence(b.node.ik)).toBe('online')
  }, 60_000)

  test("an answered call's session never makes room for another", async () => {
    const { a, b } = await pair()
    await answered(a, b)
    const s = sessionOf(a, b)
    expect(a.calls.keeps(s)).toBe(true)
    expect(b.calls.keeps(sessionOf(b, a))).toBe(true)
    const held = [{ contact: true, kept: a.calls.keeps(s), lastUseful: 0 }]
    expect(
      victimFor(held, { contact: true, kept: false }, { sessions: 1, memberSessions: 1 })
    ).toBe(null)
    a.calls.hangup()
    await waitFor(() => b.calls.view() === null, 'ended')
    expect(a.calls.keeps(s)).toBe(false)
  }, 60_000)

  test('the callee hangs up: only the caller logs', async () => {
    const { clock, a, b } = await pair()
    await answered(a, b)
    await clock.advance(3000)
    b.calls.hangup()
    await waitFor(() => a.calls.view() === null, 'ended')
    expect(b.logs).toEqual([])
    expect(a.logs).toMatchObject([{ outcome: 'ended', dur: 3 }])
  }, 60_000)

  test('decline: the caller logs a declined call', async () => {
    const { a, b } = await pair()
    await ringing(a, b)
    b.calls.decline()
    await waitFor(() => a.calls.view() === null, 'declined')
    expect(a.logs).toMatchObject([{ outcome: 'declined' }])
    expect(b.missed).toEqual([])
    expect(a.media.left).toBe(1)
    await eventually(async () => (await callRows(b, a)).length === 1, 'row synced')
    expect((await callRows(b, a))[0].outcome).toBe('declined')
  }, 60_000)

  test('no answer: missed after 30 s on both sides, the local note gives way to the row', async () => {
    const { clock, a, b } = await pair()
    await ringing(a, b)
    const id = b.calls.view()?.id as string
    await clock.advance(RING_MS)
    await waitFor(() => b.calls.view() === null, 'stopped ringing')
    expect(a.logs).toMatchObject([{ id, outcome: 'missed' }])
    expect(b.missed).toMatchObject([{ id, from: a.node.ik }])
    await eventually(async () => (await callRows(b, a)).length === 1, 'row synced')
    // The callee shows the caller's row, not its own note twice.
    const shown = withMissed(await rows(b, a), b.missed, false).filter(m => m.call)
    expect(shown.map(m => [m.call?.id, m.call?.outcome, !!m.call?.local])).toEqual([
      [id, 'missed', false],
    ])
  }, 60_000)

  test('a caller that vanishes while ringing: the callee notes the missed call itself', async () => {
    const { clock, a, b } = await pair()
    await ringing(a, b)
    const id = b.calls.view()?.id as string
    // Gone without a word (a crashed tab): no end frame, no log reaches Bob.
    a.calls = new Calls({} as never)
    a.node.stop()
    await clock.advance(RING_MS + RING_GRACE_MS)
    expect(b.calls.view()).toBeNull()
    expect(b.missed).toMatchObject([{ id, from: a.node.ik, video: false }])
    const shown = withMissed(await rows(b, a), b.missed, false).filter(m => m.call)
    expect(shown.map(m => [m.call?.outcome, m.call?.local, m.sender])).toEqual([
      ['missed', true, a.node.ik],
    ])
  }, 60_000)

  test('cancelled by the caller: missed for both', async () => {
    const { a, b } = await pair()
    await ringing(a, b)
    a.calls.hangup()
    await waitFor(() => b.calls.view() === null, 'cancelled')
    expect(a.logs).toMatchObject([{ outcome: 'missed' }])
    expect(b.missed.length).toBe(1)
  }, 60_000)

  test('busy in another call: the caller is told and logs a missed call', async () => {
    const { a, b } = await pair({}, { busy: true })
    await a.calls.start(b.node.ik, false)
    await waitFor(() => a.calls.view() === null, 'busy')
    expect(a.notices).toEqual([BUSY_TEXT('Alice')])
    expect(a.logs).toMatchObject([{ outcome: 'missed' }])
    expect(b.calls.view()).toBeNull()
  }, 60_000)

  test('a contact that is no longer mutual cannot ring', async () => {
    const { a, b } = await pair({}, { mutual: false })
    await a.calls.start(b.node.ik, false)
    await drained(sessionOf(a, b), sessionOf(b, a))
    expect(b.calls.view()).toBeNull()
    expect(sessionOf(b, a).strikes).toBe(0)
  }, 60_000)

  test('a blocked contact cannot ring, and blocking ends a call', async () => {
    const { clock, a, b } = await pair()
    await answered(a, b)
    await b.node.block(a.node.ik)
    expect(b.calls.view()).toBeNull()
    // The bye may land after a first advance: time moves on until the caller hears it.
    await eventually(async () => {
      await clock.advance(BYE_MS)
      return a.calls.view() === null
    }, 'ended for the caller')
    expect(a.logs).toMatchObject([{ outcome: 'ended' }])
    expect(await failure(a.calls.start(b.node.ik, false))).not.toBe('ok')
    expect(b.calls.view()).toBeNull()
  }, 60_000)

  test('ringing is rate limited per contact', async () => {
    const { a, b, room } = await pair({}, { busy: true })
    const busy: string[] = []
    const s = sessionOf(b, a)
    const send = s.send.bind(s)
    s.send = (m: Message) => {
      if (m.t === 'call' && m.op === 'busy') busy.push(m.id as string)
      return send(m)
    }
    const out = sessionOf(a, b)
    for (let i = 0; i < RINGS_PER_MIN + 3; i += 1)
      await out.send({
        t: 'call',
        op: 'ring',
        id: btoa(String(i).padStart(16, '0')).replace(/=+$/, ''),
        room,
        video: false,
      })
    await drained(out, s)
    expect(busy.length).toBe(RINGS_PER_MIN)
    expect(s.strikes).toBe(0)
  }, 60_000)

  test('late frames are dropped without strikes; malformed ones strike', async () => {
    const { a, b, room } = await pair()
    await answered(a, b)
    const id = a.calls.view()?.id as string
    a.calls.hangup()
    await waitFor(() => b.calls.view() === null, 'ended')
    const s = sessionOf(a, b)
    const ends: string[] = []
    const recv = sessionOf(b, a)
    const send = recv.send.bind(recv)
    recv.send = (m: Message) => {
      if (m.t === 'call' && m.op === 'end') ends.push(m.id as string)
      return send(m)
    }
    const late = {
      t: 'rtc',
      to: b.node.ik,
      target: { p2pRoom: room },
      call: id,
      payload: { candidate: { candidate: 'candidate:1 1 udp 1 10.0.0.2 1 typ host' } },
    }
    for (let i = 0; i < 5; i += 1) await s.send(late)
    await s.send({ t: 'call', op: 'end', id, room })
    await drained(s, recv)
    expect(recv.strikes).toBe(0)
    expect(b.media.signals).toEqual([])
    // Told once that the call is over.
    expect(ends).toEqual([id])
    await s.send({ ...late, payload: { candidate: { candidate: 7 } } })
    await s.send({ ...late, to: a.node.ik })
    await s.send({ ...late, target: { p2pRoom: ROOM_X } })
    await s.send({ t: 'call', op: 'ring', id, room })
    await s.send({ t: 'call', op: 'ring', id, room: ROOM_X, video: false })
    await drained(s, recv)
    expect(recv.strikes).toBe(5)
  }, 60_000)

  test('a newer peer: extra fields and unknown ops are ignored, at no strike', async () => {
    const { a, b, room } = await pair()
    const toB = newer(a, b)
    const toA = newer(b, a)
    await answered(a, b)
    const id = a.calls.view()?.id as string
    // Ops this version doesn't know, while ringing would have been too.
    await toA.send({ t: 'call', op: 'hold', id, room, until: 5 })
    await toB.send({ t: 'call', op: 'hold', id, room })
    const offer: RtcPayload = { description: { type: 'offer', sdp: 'v=0\r\n' }, sid: 'aa11' }
    a.calls.signaler.send(b.node.ik, { p2pRoom: room }, offer)
    b.calls.signaler.send(a.node.ik, { p2pRoom: room }, { muted: true, sid: 'bb22' })
    await waitFor(() => b.media.signals.length === 1 && a.media.signals.length === 1, 'signals')
    // What the media layer gets has only the fields it knows.
    expect(b.media.signals[0].payload).toEqual(offer)
    expect(a.media.signals[0].payload).toEqual({ muted: true, sid: 'bb22' })
    expect(a.calls.view()?.state).toBe('active')
    expect(b.calls.view()?.state).toBe('active')
    a.calls.hangup()
    await waitFor(() => b.calls.view() === null, 'ended')
    expect(toA.strikes + toB.strikes).toBe(0)
    expect(sessionOf(a, b).strikes + sessionOf(b, a).strikes).toBe(0)
  }, 60_000)

  test('both call each other at once: the lower id goes ahead, nobody is busy', async () => {
    const { a, b } = await pair()
    await Promise.all([a.calls.start(b.node.ik, false), b.calls.start(a.node.ik, true)])
    await waitFor(() => [a, b].some(p => p.calls.view()?.dir === 'in'), 'one side rings the other')
    const [caller, callee] = a.calls.view()?.dir === 'out' ? [a, b] : [b, a]
    await waitFor(() => callee.calls.view()?.state === 'ringing', 'ringing')
    expect(callee.calls.view()?.id).toBe(caller.calls.view()?.id)
    expect(caller.notices).toEqual([])
    expect(callee.notices).toEqual([])
    // The dropped call isn't logged.
    expect(callee.logs).toEqual([])
    await callee.calls.accept()
    await waitFor(() => caller.calls.view()?.state === 'active', 'answered')
  }, 60_000)

  test('a revoked device: its ring ends at once with no missed note, and so does its call', async () => {
    const { clock, hub, a, b } = await pair()
    await ringing(a, b)
    const a2 = await revokeBy(a, hub, clock, b)
    await waitFor(() => b.calls.view() === null, 'ring ended')
    expect(b.missed).toEqual([])
    expect(b.node.readySessions(a.node.ik).map(s => s.remote?.dk)).not.toContain(a.node.dk)
    // The revoked device can't come back to ring again.
    a.node.schedule(true)
    await settle()
    await clock.advance(5_000)
    expect(b.node.readySessions(a.node.ik).every(s => s.remote?.dk === a2.dk)).toBe(true)
    expect(await failure(a.calls.start(b.node.ik, false))).not.toBe('ok')
    expect(b.calls.view()).toBeNull()
  }, 60_000)

  test('revoked mid-call: the call ends at once, without the grace period', async () => {
    const { clock, hub, a, b } = await pair()
    await answered(b, a)
    await revokeBy(a, hub, clock, b)
    await waitFor(() => b.calls.view() === null, 'call ended')
    expect(b.logs).toMatchObject([{ outcome: 'ended' }])
  }, 60_000)

  test('the callee goes away while the caller decides about its relays: the call ends', async () => {
    let allow: (v: string | null) => void = () => {}
    const { a, b } = await pair(
      { consent: () => new Promise(r => (allow = r)) },
      { declared: ['relay.bob.example'] }
    )
    await ringing(a, b)
    await b.calls.accept()
    await waitFor(() => a.consented.length === 1, 'caller asked')
    sessionOf(a, b).close('timeout')
    allow(null)
    await waitFor(() => a.calls.view() === null, 'ended')
    expect(a.logs).toMatchObject([{ outcome: 'missed' }])
  }, 60_000)

  test('the caller denies the callee relays: logged as declined, not a 0 s call', async () => {
    const { a, b } = await pair(
      { consent: async () => 'relay.bob.example' },
      { declared: ['relay.bob.example'] }
    )
    await ringing(a, b)
    await b.calls.accept()
    await waitFor(() => a.calls.view() === null, 'denied')
    expect(a.logs).toMatchObject([{ video: false, outcome: 'declined' }])
    expect(a.logs[0].dur).toBeUndefined()
    await waitFor(() => b.calls.view() === null, 'ended for the callee')
  }, 60_000)

  test('recovering an old record leaves the record of a call started meanwhile', async () => {
    const { a, b } = await pair()
    await ringing(a, b)
    const now = a.pending as PendingCall
    await a.calls.recover({ ...now, id: 'old'.padEnd(22, 'A') })
    expect(a.pending).toEqual(now)
  }, 60_000)

  test('made-up call ids get a few answers a minute, then none', async () => {
    const { a, b, room } = await pair()
    const s = sessionOf(a, b)
    const ends: string[] = []
    const recv = sessionOf(b, a)
    const send = recv.send.bind(recv)
    recv.send = (m: Message) => {
      if (m.t === 'call' && m.op === 'end') ends.push(m.id as string)
      return send(m)
    }
    for (let i = 0; i < UNKNOWN_PER_MIN + 5; i += 1)
      await s.send({ t: 'call', op: 'accept', id: `${i}`.padStart(21, 'x') + 'A', room })
    await drained(s, recv)
    expect(ends.length).toBe(UNKNOWN_PER_MIN)
    expect(recv.strikes).toBe(0)
  }, 60_000)

  test('relays: the callee is asked before answering, Deny declines', async () => {
    const { a, b } = await pair(
      { declared: ['relay.alice.example'] },
      { consent: async () => 'relay.alice.example' }
    )
    await ringing(a, b)
    expect(await failure(b.calls.accept())).toBe(DENIED_CALL)
    expect(b.consented).toEqual([['relay.alice.example']])
    expect(b.media.target).toBeNull()
    await waitFor(() => a.calls.view() === null, 'declined')
    expect(a.logs).toMatchObject([{ outcome: 'declined' }])
  }, 60_000)

  test('relays: the caller asks about the callee relays and holds negotiation until then', async () => {
    let allow: (v: string | null) => void = () => {}
    const { a, b, room } = await pair(
      { consent: () => new Promise(r => (allow = r)) },
      { declared: ['relay.bob.example'] }
    )
    await ringing(a, b)
    await b.calls.accept()
    await waitFor(() => a.consented.length === 1, 'caller asked')
    expect(a.consented).toEqual([['relay.bob.example']])
    const offer: RtcPayload = { description: { type: 'offer', sdp: 'v=0\r\n' }, sid: 'bb22' }
    b.calls.signaler.send(a.node.ik, { p2pRoom: room }, offer)
    await drained(sessionOf(b, a), sessionOf(a, b))
    // Nothing reaches the media (and so no candidates of ours go out) before the answer.
    expect(a.media.signals).toEqual([])
    expect(a.media.synced).toEqual([])
    expect(a.calls.view()?.state).toBe('ringing')
    allow(null)
    await waitFor(() => a.media.signals.length === 1, 'released')
    expect(a.calls.view()?.state).toBe('active')
    expect(a.media.signals[0].payload).toEqual(offer)
  }, 60_000)

  test('relay only on this side: nobody is asked', async () => {
    const { a, b } = await pair(
      { relayOnly: true, declared: ['relay.alice.example'] },
      { relayOnly: true, declared: ['relay.bob.example'] }
    )
    await answered(a, b)
    expect(a.consented).toEqual([])
    expect(b.consented).toEqual([])
    expect(a.calls.config().iceTransportPolicy).toBe('relay')
  }, 60_000)

  test('reload mid-call: the other side ends at once and the log comes from the pending record', async () => {
    const { clock, a, b } = await pair()
    await answered(a, b)
    const id = a.calls.view()?.id as string
    await clock.advance(25_000)
    const pending = a.pending as PendingCall
    expect(pending.id).toBe(id)
    expect(typeof pending.answeredAt).toBe('number')
    // The page goes away: stop() as on pagehide, then the node.
    a.calls.stop()
    a.node.stop()
    await waitFor(() => b.node.readySessions(a.node.ik).length === 0, 'session closed')
    await clock.advance(BYE_MS)
    await waitFor(() => b.calls.view() === null, 'ended for the callee')
    expect(b.media.left).toBe(1)
    expect(a.logs).toEqual([])
    // The next start of the tab logs it from what was saved (the last alive mark, 20 s in).
    await a.calls.recover(pending)
    expect(a.logs).toEqual([{ id, video: false, outcome: 'ended', dur: 20 }])
    expect(a.pending).toBeNull()
  }, 60_000)

  test('a lost session ends an answered call after a grace period', async () => {
    const { clock, hub, a, b } = await pair()
    await answered(a, b)
    hub.drop(b.node.peerId)
    sessionOf(a, b).close('timeout')
    await clock.advance(BYE_MS)
    expect(a.calls.view()?.state).toBe('active')
    await clock.advance(20_000)
    expect(a.calls.view()).toBeNull()
    expect(a.logs).toMatchObject([{ outcome: 'ended' }])
  }, 60_000)
})

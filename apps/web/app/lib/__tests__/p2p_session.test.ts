import { describe, expect, test } from 'bun:test'
import { keyId, newKeyPair, peerId, signCert, withSuffix, type KeyPair } from '../p2p/keys'
import { HandshakeError, Initiator, Responder, type Me } from '../p2p/handshake'
import {
  chunk,
  Cipher,
  CHUNK_DATA,
  dataPayload,
  decodeFrame,
  encodeFrame,
  FrameType,
  MESSAGE_MAX,
  parseData,
  Reassembler,
  WIRE_MAX,
} from '../p2p/frames'
import { LIMITS, Session, type SessionOpts } from '../p2p/session'
import { ManualClock, pipePair, settle } from './p2p_net'

const device = (suffix = 0): Me & { ik: KeyPair } => {
  const ik = newKeyPair()
  const dk = newKeyPair()
  return { ik, dk, cert: signCert(ik, dk.pk, 1, 'test'), peer: withSuffix(peerId(dk.pk), suffix) }
}

const fails = async (p: Promise<unknown>) => {
  try {
    await p
    return false
  } catch (e) {
    return e instanceof HandshakeError
  }
}

const eq = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((x, i) => x === b[i])

describe('handshake', () => {
  test('in-memory success with matching keys', async () => {
    const i = device()
    const r = device(2)
    const init = new Initiator(i, r.peer)
    const resp = new Responder(r, i.peer)
    const h2 = await resp.h1(init.h1())
    const a = await init.h2(h2)
    const b = await resp.h3(a.h3)
    expect(a.remote.dk).toBe(keyId(r.dk.pk))
    expect(a.remote.ik).toBe(keyId(r.ik.pk))
    expect(b.remote.ik).toBe(keyId(i.ik.pk))
    expect(eq(a.keys.send, b.keys.recv)).toBe(true)
    expect(eq(a.keys.recv, b.keys.send)).toBe(true)
    expect(eq(a.keys.bulkSend, b.keys.bulkRecv)).toBe(true)
    expect(eq(a.keys.send, a.keys.recv)).toBe(false)
    expect(eq(a.keys.send, a.keys.bulkSend)).toBe(false)
  })

  test('the initiator identity never travels in clear', async () => {
    const i = device()
    const r = device()
    const init = new Initiator(i, r.peer)
    const resp = new Responder(r, i.peer)
    const h1 = init.h1()
    const a = await init.h2(await resp.h1(h1))
    const clear = new TextDecoder().decode(new Uint8Array([...h1, ...a.h3]))
    expect(clear.includes(keyId(i.ik.pk))).toBe(false)
    expect(clear.includes(keyId(i.dk.pk))).toBe(false)
  })

  test('a MITM swapping ephemerals fails', async () => {
    const i = device()
    const r = device()
    const m = device()
    const init = new Initiator(i, r.peer)
    // The MITM relays to R with its own ephemeral, then to I with R's reply.
    const mInit = new Initiator(m, r.peer)
    const resp = new Responder(r, i.peer)
    const h1 = init.h1()
    void h1
    const h2 = await resp.h1(mInit.h1())
    expect(await fails(init.h2(h2))).toBe(true)
    // Replacing just the ephemeral key in H2 breaks decryption too.
    const init2 = new Initiator(i, r.peer)
    const resp2 = new Responder(r, i.peer)
    const real = JSON.parse(new TextDecoder().decode(await resp2.h1(init2.h1())))
    const mitmH2 = await new Responder(m, i.peer).h1(new Initiator(i, m.peer).h1())
    const mitmE = JSON.parse(new TextDecoder().decode(mitmH2)).e
    const swapped = new TextEncoder().encode(JSON.stringify({ box: real.box, e: mitmE, n: real.n }))
    expect(await fails(init2.h2(swapped))).toBe(true)
  })

  test('a responder that is not the dialed peer fails', async () => {
    const i = device()
    const r = device()
    const other = device()
    const init = new Initiator(i, other.peer)
    const resp = new Responder(r, i.peer)
    expect(await fails(init.h2(await resp.h1(init.h1())))).toBe(true)
  })

  test('an initiator not owning its peer id fails at the responder', async () => {
    const i = device()
    const r = device()
    const init = new Initiator(i, r.peer)
    const resp = new Responder(r, device().peer)
    // The responder signs a transcript naming the claimed id, so the initiator rejects it.
    expect(await fails(init.h2(await resp.h1(init.h1())))).toBe(true)
  })

  test('a replayed H1 cannot complete', async () => {
    const i = device()
    const r = device()
    const init = new Initiator(i, r.peer)
    const h1 = init.h1()
    const resp = new Responder(r, i.peer)
    const a = await init.h2(await resp.h1(h1))
    await resp.h3(a.h3)
    // An attacker replays H1 and the old H3 to a fresh responder.
    const replay = new Responder(r, i.peer)
    await replay.h1(h1)
    expect(await fails(replay.h3(a.h3))).toBe(true)
    // And messages out of order are refused.
    expect(await fails(new Responder(r, i.peer).h3(a.h3))).toBe(true)
    expect(await fails(init.h2(new Uint8Array([123, 125])))).toBe(true)
  })

  test('purpose must match', async () => {
    const i = device()
    const r = device()
    const init = new Initiator(i, r.peer, 'rekey')
    expect(await fails(new Responder(r, i.peer).h1(init.h1()))).toBe(true)
  })
})

describe('frames', () => {
  test('framing round trip and limits', () => {
    const f = encodeFrame(FrameType.H1, new Uint8Array([1, 2, 3]))
    expect([...f]).toEqual([1, 0, 0, 0, 3, 1, 2, 3])
    const d = decodeFrame(f)
    expect(d.type).toBe(FrameType.H1)
    expect([...d.payload]).toEqual([1, 2, 3])
    const bad = [
      new Uint8Array([1, 0, 0]),
      new Uint8Array([1, 0, 0, 0, 4, 1, 2, 3]),
      new Uint8Array([9, 0, 0, 0, 0]),
      encodeFrame(FrameType.Data, new Uint8Array(17 * 1024)),
    ]
    for (const b of bad) {
      let threw = false
      try {
        decodeFrame(b)
      } catch {
        threw = true
      }
      expect(threw).toBe(true)
    }
  })

  test('counters: reuse and skips are rejected', async () => {
    const key = crypto.getRandomValues(new Uint8Array(32))
    const tx = new Cipher(key.slice())
    const rx = new Cipher(key.slice())
    const a = await tx.seal(new Uint8Array([1]))
    const b = await tx.seal(new Uint8Array([2]))
    const c = await tx.seal(new Uint8Array([3]))
    expect([...(await rx.open(a.counter, a.ct))]).toEqual([1])
    const reason = async (n: number, ct: Uint8Array) => {
      try {
        await rx.open(n, ct)
        return 'ok'
      } catch (e) {
        return (e as Error).message
      }
    }
    expect(await reason(a.counter, a.ct)).toBe('counter reused')
    expect(await reason(c.counter, c.ct)).toBe('counter skipped')
    // A ciphertext presented under another counter doesn't authenticate.
    expect(await reason(1, c.ct)).toBe('frame did not authenticate')
    void b
    const p = dataPayload(3, 2 ** 40, new Uint8Array(16))
    expect(parseData(p).epoch).toBe(3)
    expect(parseData(p).counter).toBe(2 ** 40)
  })

  test('chunking and reassembly', () => {
    const msg = crypto.getRandomValues(new Uint8Array(CHUNK_DATA * 2 + 10))
    const parts = chunk(msg)
    expect(parts).toHaveLength(3)
    const r = new Reassembler()
    expect(r.push(parts[0])).toBeNull()
    expect(r.push(parts[1])).toBeNull()
    expect(eq(r.push(parts[2]) as Uint8Array, msg)).toBe(true)
    let threw = false
    try {
      new Reassembler().push(parts[1])
    } catch {
      threw = true
    }
    expect(threw).toBe(true)
    threw = false
    try {
      chunk(new Uint8Array(MESSAGE_MAX + 1))
    } catch {
      threw = true
    }
    expect(threw).toBe(true)
    const small = new Reassembler(CHUNK_DATA)
    threw = false
    try {
      small.push(parts[0])
      small.push(parts[1])
    } catch {
      threw = true
    }
    expect(threw).toBe(true)
  })
})

const pair = (
  over: Partial<SessionOpts> = {},
  tamper?: (d: Uint8Array, from: 'a' | 'b') => Uint8Array | null
) => {
  const i = device()
  const r = device(1)
  const clock = new ManualClock()
  const wire = { cut: false, tamper }
  const { a, b } = pipePair(i.peer, r.peer, wire)
  const got: Record<'a' | 'b', string[]> = { a: [], b: [] }
  const opts = (
    me: Me,
    role: 'initiator' | 'responder',
    pipe: typeof a,
    name: 'a' | 'b'
  ): SessionOpts => ({
    role,
    pipe,
    me,
    clock,
    hello: () => ({ t: 'hello', from: name }),
    onHello: () => true,
    ...over,
  })
  const sa = new Session(opts(i, 'initiator', a, 'a'))
  const sb = new Session(opts(r, 'responder', b, 'b'))
  for (const [s, name] of [
    [sa, 'a'],
    [sb, 'b'],
  ] as const)
    s.on('text', m => void got[name].push(String(m.body)))
  sb.start()
  sa.start()
  return { i, r, sa, sb, a, b, clock, got, wire }
}

describe('session', () => {
  test('handshake, hello and messages both ways', async () => {
    const { sa, sb, got, i, r } = pair()
    await settle()
    expect(sa.state).toBe('ready')
    expect(sb.state).toBe('ready')
    expect(sa.remote?.ik).toBe(keyId(r.ik.pk))
    expect(sb.remote?.ik).toBe(keyId(i.ik.pk))
    await sa.send({ t: 'text', body: 'hi' })
    await sb.send({ t: 'text', body: 'x'.repeat(40_000) })
    await settle()
    expect(got.b).toEqual(['hi'])
    expect(got.a[0]).toHaveLength(40_000)
  })

  test('admit can refuse a remote', async () => {
    const { sa, sb } = pair({ admit: () => false })
    await settle()
    expect(sa.state).toBe('closed')
    expect(sb.state).toBe('closed')
  })

  test('replayed data frames are rejected', async () => {
    let captured: Uint8Array | null = null
    const { sa, sb, got, b } = pair({}, (d, from) => {
      if (from === 'a' && d[0] === FrameType.Data && captured === null) captured = d
      return d
    })
    await settle()
    void sb
    await sa.send({ t: 'text', body: 'one' })
    await settle()
    // Inject the first data frame (the hello) again.
    ;(b as unknown as { deliver: (d: Uint8Array) => void }).deliver(
      captured as unknown as Uint8Array
    )
    await settle()
    expect(got.b).toEqual(['one'])
    expect(sb.state).toBe('closed')
    expect(sb.reason).toBe('strikes')
  })

  test('message types from a newer version are ignored without a strike', async () => {
    const { sa, sb } = pair({ limits: { strikes: 3 } })
    await settle()
    for (let n = 0; n < 5; n += 1) await sa.send({ t: 'nonsense', extra: n })
    await settle()
    expect(sb.state).toBe('ready')
    expect(sb.strikes).toBe(0)
  })

  test('messages before hello are refused', async () => {
    const { sa, sb } = pair({ onHello: () => new Promise<boolean>(() => {}) })
    await settle()
    expect(sa.state).toBe('open')
    void sb
  })

  test('ping keeps it alive; silence kills it', async () => {
    const { sa, sb, clock, wire } = pair()
    await settle()
    await clock.advance(100_000)
    expect(sa.state).toBe('ready')
    expect(sb.state).toBe('ready')
    wire.cut = true
    await clock.advance(90_000)
    expect(sa.state).toBe('closed')
    expect(sa.reason).toBe('timeout')
  })

  test('handshake timeout', async () => {
    const { sa, sb, clock } = pair({}, () => null)
    await clock.advance(11_000)
    expect(sa.state).toBe('closed')
    expect(sb.state).toBe('closed')
    expect([sa.reason, sb.reason]).toContain('handshake')
  })

  test('rekey switches to new keys without losing messages', async () => {
    const { sa, sb, got } = pair()
    await settle()
    expect(sa.epoch).toBe(0)
    const sending = sb.send({ t: 'text', body: 'before' })
    await sa.rekey()
    await sending
    for (let n = 0; n < 5; n += 1) {
      void sa.send({ t: 'text', body: `a${n}` })
      void sb.send({ t: 'text', body: `b${n}` })
    }
    await settle()
    expect(sa.epoch).toBe(1)
    expect(sb.epoch).toBe(1)
    expect(got.b).toEqual(['a0', 'a1', 'a2', 'a3', 'a4'])
    expect(got.a).toEqual(['before', 'b0', 'b1', 'b2', 'b3', 'b4'])
    expect(sa.state).toBe('ready')
    expect(sb.state).toBe('ready')
  })

  test('a full 1 MiB message and a burst of two arrive without strikes', async () => {
    const { sa, sb, got, clock } = pair()
    await settle()
    const body = 'x'.repeat(MESSAGE_MAX - 64)
    await sa.send({ t: 'text', body })
    await settle()
    expect(got.b).toHaveLength(1)
    expect(got.b[0]).toHaveLength(body.length)
    // The bucket refills; then two at once still fit the burst, with no time passing.
    await clock.advance(5000)
    await Promise.all([sa.send({ t: 'text', body }), sa.send({ t: 'text', body })])
    await settle()
    expect(got.b).toHaveLength(3)
    expect(sb.state).toBe('ready')
    expect(sb.strikes).toBe(0)
  })

  test('three max-size messages at once wait for tokens without hitting the byte cap', async () => {
    const { sa, sb, got, clock } = pair()
    await settle()
    const body = 'x'.repeat(MESSAGE_MAX - 64)
    await Promise.all([1, 2, 3].map(() => sa.send({ t: 'text', body })))
    await settle()
    expect(sb.state).toBe('ready')
    await clock.advance(5000)
    expect(got.b).toHaveLength(3)
    expect(sb.state).toBe('ready')
    expect(sb.strikes).toBe(0)
  })

  test('a flood past the burst is slowed down, not dropped or banned', async () => {
    const { sa, sb, got, clock } = pair({ limits: { framesPerSec: 50, frameBurst: 20 } })
    await settle()
    for (let n = 0; n < 60; n += 1) void sa.send({ t: 'text', body: `m${n}` })
    await settle()
    // The burst (less the hellos) goes through at once, the rest waits for tokens.
    expect(got.b.length < 60).toBe(true)
    expect(sb.state).toBe('ready')
    await clock.advance(2000)
    expect(got.b).toEqual(Array.from({ length: 60 }, (_, n) => `m${n}`))
    expect(sb.state).toBe('ready')
    expect(sb.strikes).toBe(0)
  })

  test('pings never stretch the handshake deadline: no hello means closed as handshake', async () => {
    // Both sides answer pings but never send a hello.
    const { sa, sb, clock } = pair({ hello: () => ({ t: 'ping' }) })
    await settle()
    expect(sa.state).toBe('open')
    expect(sb.state).toBe('open')
    await clock.advance(LIMITS.handshakeMs - 1000)
    expect(sb.state).toBe('open')
    await clock.advance(10 * 60_000)
    expect(sb.state).toBe('closed')
    expect(sb.reason).toBe('handshake')
    expect(sa.state).toBe('closed')
  })

  test('a ready session outlives the handshake deadline', async () => {
    const { sa, sb, clock } = pair()
    await settle()
    await clock.advance(LIMITS.handshakeMs * 3)
    expect(sa.state).toBe('ready')
    expect(sb.state).toBe('ready')
  })

  // Spends the burst so the next frame waits for tokens and everything after it queues.
  const stall = async (over: Partial<SessionOpts> = {}) => {
    const p = pair({ limits: { frameBurst: 4, framesPerSec: 1 }, ...over })
    await settle()
    for (let n = 0; n < 8; n += 1) void p.sa.send({ t: 'ping' })
    await settle()
    return p
  }
  const junk = (len: number) => encodeFrame(FrameType.Data, new Uint8Array(len - 5))
  const inject = (end: unknown, d: Uint8Array) =>
    (end as { deliver: (d: Uint8Array) => void }).deliver(d)

  test('an oversized frame closes the session before it is queued', async () => {
    const { sb, b } = await stall()
    expect(sb.state).toBe('ready')
    inject(b, junk(WIRE_MAX + 1))
    await settle()
    expect(sb.state).toBe('closed')
    expect(sb.reason).toBe('strikes')
  })

  test('frames queued behind the throttle stay within the byte cap', async () => {
    const { sb, b } = await stall()
    let peak = 0
    let sent = 0
    for (; sent < 1000 && sb.state !== 'closed'; sent += 1) {
      inject(b, junk(WIRE_MAX))
      await settle(1)
      peak = Math.max(peak, sb.queued)
    }
    expect(sb.state).toBe('closed')
    expect(sb.reason).toBe('strikes')
    expect(peak <= LIMITS.frameBacklogBytes).toBe(true)
    expect(sent * WIRE_MAX < LIMITS.frameBacklogBytes + 2 * WIRE_MAX).toBe(true)
  })

  test('a stranger flooding before its hello is closed as a failed handshake', async () => {
    const { sb, b } = await stall({ hello: () => ({ t: 'ping' }) })
    expect(sb.state).toBe('open')
    for (let n = 0; n < 1000 && sb.state !== 'closed'; n += 1) {
      inject(b, junk(WIRE_MAX))
      await settle(1)
    }
    expect(sb.state).toBe('closed')
    expect(sb.reason).toBe('handshake')
  })

  test('a rekey that never finishes ends the session without a ban', async () => {
    let drop = false
    const { sa, sb, clock } = pair({}, (d, from) => (drop && from === 'b' ? null : d))
    await settle()
    drop = true
    await sa.rekey()
    await clock.advance(11_000)
    expect(sa.state).toBe('closed')
    expect(sa.reason).toBe('timeout')
    void sb
  })

  test('rekey runs on its own after the interval', async () => {
    const { sa, sb, clock } = pair({ limits: { rekeyMs: 30_000 } })
    await settle()
    await clock.advance(45_000)
    expect(sa.epoch).toBe(1)
    expect(sb.epoch).toBe(1)
  })
})

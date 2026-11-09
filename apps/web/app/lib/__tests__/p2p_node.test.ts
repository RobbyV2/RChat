import { afterEach, describe, expect, test } from 'bun:test'
import { Hub, makeNode, ManualClock, settle, waitFor } from './p2p_net'
import {
  P2pNode,
  ELSEWHERE,
  LIMITS,
  OTHER_HOST,
  TransportError,
  type Visibility,
} from '../p2p/node'
import { P2pStore, removeP2pDb, type SelfRecord } from '../p2p/db'
import { keyId, newKeyPair, peerId, signCert, signRevocation, withSuffix } from '../p2p/keys'
import { encodeCard, makeCard } from '../p2p/card'
import { requests } from '../p2p/contacts'
import { HANDOVER_MS, TabLeader, type ChannelLike, type LockLike } from '../p2p/leader'
import { LIMITS as SESSION_LIMITS, Session } from '../p2p/session'

const nodes: P2pNode[] = []
afterEach(() => {
  for (const n of nodes.splice(0)) n.stop()
})

const setup = async (names: string[], clock = new ManualClock()) => {
  const hub = new Hub()
  const out = []
  for (const name of names) {
    const n = await makeNode(hub, name, { clock })
    nodes.push(n.node)
    await n.node.start()
    out.push(n)
  }
  return { hub, clock, out }
}

const befriend = async (a: P2pNode, b: P2pNode, clock: ManualClock, intro = 'Hi from A') => {
  const res = await a.addContact(await b.myCard(), intro)
  expect(res.ok).toBe(true)
  await waitFor(() => b.contact(a.ik)?.state === 'incoming', 'the request')
  expect(b.contact(a.ik)?.intros).toEqual([intro])
  await b.accept(a.ik)
  await waitFor(
    () => a.presence(b.ik) === 'online' && b.presence(a.ik) === 'online',
    'mutual presence'
  )
  void clock
}

describe('P2P node', () => {
  test('request, accept, mutual with presence both ways', async () => {
    const { out, clock } = await setup(['Alice', 'Bob'])
    const [a, b] = out.map(x => x.node)
    expect(a.status).toBe('online')
    await befriend(a, b, clock)
    expect(a.contact(b.ik)?.state).toBe('mutual')
    expect(b.contact(a.ik)?.state).toBe('mutual')
    expect(a.presence(b.ik)).toBe('online')
    expect(b.presence(a.ik)).toBe('online')
    expect(a.contact(b.ik)?.name).toBe('Bob')
    expect(b.contact(a.ik)?.name).toBe('Alice')
    // Bob goes away: Alice sees him offline.
    b.stop()
    await waitFor(() => a.presence(b.ik) === 'offline', 'offline')
    expect(a.contact(b.ik)?.lastSeen !== null).toBe(true)
  })

  test('a newer peer: hello and session fields it adds cost nothing; an unknown relation changes nothing', async () => {
    const { out, clock } = await setup(['Alice', 'Bob'])
    const [a, b] = out.map(x => x.node)
    type Hello = { helloFor: (r: unknown) => Record<string, unknown> }
    const patch = (n: P2pNode, extra: Record<string, unknown>) => {
      const h = n as unknown as Hello
      const orig = h.helloFor.bind(n)
      h.helloFor = r => ({ ...orig(r), ...extra })
    }
    patch(a, { caps: ['calls2'], future: { x: 1 } })
    patch(b, { caps: [] })
    await befriend(a, b, clock)
    const sessions = [...a.readySessions(b.ik), ...b.readySessions(a.ik)]
    await sessions[0].send({ t: 'profile2', profile: null })
    // A profile of a newer version this one can't check: kept as it was, no strike.
    const name = b.contact(a.ik)?.name
    await sessions[0].send({ t: 'profile', profile: { ...a.profile, v: 2, name: 'Newer' } })
    await settle()
    expect(sessions.map(s => s.strikes)).toEqual([0, 0])
    expect(b.contact(a.ik)?.name).toBe(name as string)
    // A relation a newer version adds: read as pending. The signed profile still counts, the
    // contact stays as it was and nobody is banned.
    b.stop()
    await waitFor(() => a.presence(b.ik) === 'offline', 'offline')
    await b.setName('Bobby')
    patch(b, { rel: 'family' })
    await b.start()
    b.schedule(true)
    await waitFor(() => a.contact(b.ik)?.name === 'Bobby', 'profile read')
    expect(a.contact(b.ik)?.state).toBe('mutual')
    expect((a as unknown as { banned: Map<string, number> }).banned.has(b.ik)).toBe(false)
  })

  test('both add each other: mutual without an accept', async () => {
    const { out } = await setup(['Alice', 'Bob'])
    const [a, b] = out.map(x => x.node)
    await b.setPaused(true)
    await a.addContact(await b.myCard())
    await b.addContact(await a.myCard())
    await b.setPaused(false)
    await waitFor(() => a.presence(b.ik) === 'online', 'presence')
    expect(a.contact(b.ik)?.state).toBe('mutual')
    expect(b.contact(a.ik)?.state).toBe('mutual')
    expect(a.presence(b.ik)).toBe('online')
  })

  test('contacts and identity persist in IndexedDB', async () => {
    const hub = new Hub()
    const clock = new ManualClock()
    const a = await makeNode(hub, 'Alice', { clock })
    const b = await makeNode(hub, 'Bob', { clock })
    nodes.push(a.node, b.node)
    await a.node.start()
    await b.node.start()
    await befriend(a.node, b.node, clock)
    await a.node.rename(b.node.ik, 'Bobby')
    await a.node.markVerified(b.node.ik)
    const ik = a.node.ik
    a.node.stop()
    a.store.close()
    const again = await P2pStore.open(a.db)
    const reopened = (await P2pNode.open({
      store: again,
      transport: hub.transport(),
      host: 'chat.example',
      clock,
    })) as P2pNode
    nodes.push(reopened)
    expect(reopened.ik).toBe(ik)
    expect(reopened.contact(b.node.ik)?.state).toBe('mutual')
    expect(reopened.contact(b.node.ik)?.petname).toBe('Bobby')
    expect(reopened.contact(b.node.ik)?.verified).toBe(true)
    await reopened.start()
    await waitFor(() => reopened.presence(b.node.ik) === 'online', 'presence after reopen')
    // Without create, an empty database has no identity.
    const empty = await P2pStore.open(`empty-${Math.random()}`)
    expect(await P2pNode.open({ store: empty, transport: hub.transport(), host: 'x' })).toBeNull()
    again.close()
    await removeP2pDb(a.db)
  })

  test('QR verification marks both sides', async () => {
    const { out, clock } = await setup(['Alice', 'Bob'])
    const [a, b] = out.map(x => x.node)
    await befriend(a, b, clock)
    const code = a.verifyCodeFor(b.ik)
    const wrong = await b.scanVerifyCode(
      a.ik,
      code.replace(/.$/, c => (c === 'A' ? 'B' : 'A'))
    )
    expect(wrong.ok).toBe(false)
    expect((await b.scanVerifyCode(a.ik, code)).ok).toBe(true)
    await waitFor(() => a.contact(b.ik)?.verified === true, 'verified at A')
    expect(b.contact(a.ik)?.verified).toBe(true)
    expect(a.contact(b.ik)?.verified).toBe(true)
    // A code meant for someone else is refused.
    const { out: more } = await setup(['Carol'])
    expect((await more[0].node.scanVerifyCode(a.ik, a.verifyCodeFor(b.ik))).ok).toBe(false)
  })

  test('block refuses sessions; ignore hides the request', async () => {
    const { out, clock } = await setup(['Alice', 'Bob', 'Eve'])
    const [a, b, e] = out.map(x => x.node)
    await befriend(a, b, clock)
    await b.block(a.ik)
    await waitFor(() => a.presence(b.ik) === 'offline', 'offline after block')
    await clock.advance(LIMITS.backoff[1] + 1000)
    expect(a.presence(b.ik)).toBe('offline')
    expect(b.contact(a.ik)?.state).toBe('blocked')

    await e.addContact(await a.myCard(), 'let me in')
    await waitFor(() => a.contact(e.ik)?.state === 'incoming', 'the request')
    await a.ignore(e.ik)
    await clock.advance(LIMITS.backoff[1] + 1000)
    expect(a.contact(e.ik)?.ignored).toBe(true)
    expect(a.contact(e.ik)?.intros).toEqual([])
    // An ignored requester is told the same as one still waiting.
    expect((a as unknown as { relOf: (ik: string) => string }).relOf(e.ik)).toBe('pending')
  })

  test('cards from another instance are refused', async () => {
    const hub = new Hub()
    const other = await makeNode(hub, 'Far', { host: 'other.example' })
    const { out } = await setup(['Alice'])
    nodes.push(other.node)
    const res = await out[0].node.addContact(await other.node.myCard())
    expect(res).toEqual({ ok: false, error: OTHER_HOST('other.example') })
  })

  test('a reset without succession raises a warning; with succession contacts move', async () => {
    const hub = new Hub()
    const clock = new ManualClock()
    const a = await makeNode(hub, 'Alice', { clock })
    const b = await makeNode(hub, 'Bob', { clock })
    nodes.push(a.node, b.node)
    await a.node.start()
    await b.node.start()
    await befriend(a.node, b.node, clock)
    await a.node.markVerified(b.node.ik)

    // Bob resets with succession: Alice moves the contact and drops verification.
    const oldIk = b.node.ik
    await b.node.resetIdentity()
    // The first session after the reset ends early (Alice's hello can't know the new key yet);
    // Bob dials again, without waiting for the backoff.
    await waitFor(() => {
      b.node.schedule(true)
      return a.node.presence(b.node.ik) === 'online'
    }, 'presence after the reset')
    expect(a.node.contact(oldIk)).toBeUndefined()
    const moved = a.node.contact(b.node.ik)
    expect(moved?.notice?.kind).toBe('reset')
    expect(moved?.verified).toBe(false)
    expect(moved?.state).toBe('mutual')
    expect(a.node.presence(b.node.ik)).toBe('online')

    // Bob wipes everything and starts over with the same name: Alice sees a warning.
    b.node.stop()
    b.store.close()
    await removeP2pDb(b.db)
    const fresh = await makeNode(hub, 'Bob', { clock })
    nodes.push(fresh.node)
    await fresh.node.start()
    await fresh.node.addContact(await a.node.myCard(), "it's Bob, new browser")
    await waitFor(() => a.node.contact(fresh.node.ik) !== undefined, 'the new request')
    const req = a.node.contact(fresh.node.ik)
    expect(req?.state).toBe('incoming')
    expect(req?.warning).toBe(b.node.ik)
  })

  test('a squatted peer id moves to a suffix that contacts still find', async () => {
    const hub = new Hub()
    const clock = new ManualClock()
    const a = await makeNode(hub, 'Alice', { clock })
    const b = await makeNode(hub, 'Bob', { clock })
    nodes.push(a.node, b.node)
    hub.squatted.add(peerId(b.node.dk))
    hub.squatted.add(withSuffix(peerId(b.node.dk), 1))
    await a.node.start()
    await b.node.start()
    expect(b.node.peerId).toBe(withSuffix(peerId(b.node.dk), 2))
    await befriend(a.node, b.node, clock)
    expect(a.node.presence(b.node.ik)).toBe('online')
    // Every suffix taken: the node says so.
    const c = await makeNode(hub, 'Carol', { clock })
    nodes.push(c.node)
    for (let n = 0; n <= 3; n += 1) hub.squatted.add(withSuffix(peerId(c.node.dk), n))
    await c.node.start()
    expect(c.node.status).toBe('squatted')
  })

  test('an unreachable signaling server says so, retries in the background and on request', async () => {
    const hub = new Hub()
    const clock = new ManualClock()
    const a = await makeNode(hub, 'Alice', { clock })
    nodes.push(a.node)
    const t = hub.transport()
    let down = true
    let tries = 0
    ;(a.node as unknown as { deps: { transport: typeof t } }).deps.transport = {
      ...t,
      listen: (id, onPipe, onLost) => {
        tries += 1
        return down ? Promise.reject(new TransportError('timeout')) : t.listen(id, onPipe, onLost)
      },
    }
    const seen: string[] = []
    a.node.onChange(() => seen.push(a.node.status))
    await a.node.start()
    expect(a.node.status).toBe('unreachable')
    expect(tries).toBe(1)
    // The background retry keeps saying so instead of going back to "connecting".
    seen.length = 0
    await clock.advance(LIMITS.backoff[1] + 1000)
    expect(tries).toBe(2)
    expect(seen.includes('connecting')).toBe(false)
    expect(a.node.status).toBe('unreachable')
    // Retry tries at once and comes online.
    down = false
    await a.node.retry()
    expect(tries).toBe(3)
    expect(a.node.status).toBe('online')
    await a.node.retry()
    expect(tries).toBe(3)
    // Losing the server after that says so at once, and Retry registers again.
    hub.drop(a.node.peerId)
    expect(a.node.status).toBe('unreachable')
    await a.node.retry()
    expect(tries).toBe(4)
    expect(a.node.status).toBe('online')
  })

  test('a browser without WebRTC says so and never tries again', async () => {
    const hub = new Hub()
    const clock = new ManualClock()
    const a = await makeNode(hub, 'Alice', { clock })
    nodes.push(a.node)
    const t = hub.transport()
    let tries = 0
    ;(a.node as unknown as { deps: { transport: typeof t } }).deps.transport = {
      ...t,
      listen: () => {
        tries += 1
        return Promise.reject(new TransportError('unsupported'))
      },
    }
    await a.node.start()
    expect(a.node.status).toBe('unsupported')
    await clock.advance(LIMITS.backoff[4] + 1000)
    await a.node.retry()
    expect(tries).toBe(1)
    expect(a.node.status).toBe('unsupported')
  })

  // Registrations that are still running when the user pauses, or that a newer one replaced.
  const slowListens = (node: P2pNode, hub: Hub) => {
    const t = hub.transport()
    const held: { fail: () => void; pass: () => Promise<void> }[] = []
    ;(node as unknown as { deps: { transport: typeof t } }).deps.transport = {
      ...t,
      listen: (id, onPipe, onLost) =>
        new Promise((resolve, reject) => {
          held.push({
            fail: () => reject(new TransportError('timeout')),
            pass: () => t.listen(id, onPipe, onLost).then(resolve, reject),
          })
        }),
    }
    return held
  }

  test('a registration that fails late never says "unreachable" while paused or replaced', async () => {
    const hub = new Hub()
    const clock = new ManualClock()
    const a = await makeNode(hub, 'Alice', { clock })
    nodes.push(a.node)
    const held = slowListens(a.node, hub)
    void a.node.start()
    await settle()
    expect(a.node.status).toBe('connecting')
    await a.node.setPaused(true)
    held[0].fail()
    await settle()
    expect(a.node.status).toBe('paused')
    // Resuming registers again; the first try's late failure doesn't count.
    void a.node.setPaused(false)
    await settle()
    expect(held.length).toBe(2)
    await held[1].pass()
    await settle()
    expect(a.node.status).toBe('online')
    const b = await makeNode(hub, 'Bob', { clock })
    nodes.push(b.node)
    const bHeld = slowListens(b.node, hub)
    void b.node.start()
    await settle()
    await b.node.setPaused(true)
    void b.node.setPaused(false)
    await settle()
    bHeld[0].fail()
    await settle()
    expect(b.node.status).toBe('connecting')
    await bHeld[1].pass()
    await settle()
    expect(b.node.status).toBe('online')
  })

  test('Retry during a background try shows it is connecting and waits for that try', async () => {
    const hub = new Hub()
    const clock = new ManualClock()
    const a = await makeNode(hub, 'Alice', { clock })
    nodes.push(a.node)
    const held = slowListens(a.node, hub)
    void a.node.start()
    await settle()
    held[0].fail()
    await settle()
    expect(a.node.status).toBe('unreachable')
    await clock.advance(LIMITS.backoff[1] + 1000)
    expect(held.length).toBe(2)
    expect(a.node.status).toBe('unreachable')
    await a.node.retry()
    expect(a.node.status).toBe('connecting')
    expect(held.length).toBe(2)
    held[1].fail()
    await settle()
    expect(a.node.status).toBe('unreachable')
  })

  test('the dial scheduler keeps at most 4 dials in flight and backs off', async () => {
    const hub = new Hub()
    const clock = new ManualClock()
    const a = await makeNode(hub, 'Alice', { clock })
    nodes.push(a.node)
    // Ten offline contacts whose dials hang until released.
    const release: (() => void)[] = []
    let peak = 0
    let live = 0
    const t = hub.transport()
    ;(a.node as unknown as { deps: { transport: typeof t } }).deps.transport = {
      listen: t.listen,
      dial: () =>
        new Promise((_, reject) => {
          live += 1
          peak = Math.max(peak, live)
          release.push(() => {
            live -= 1
            reject(new Error('peer-unavailable'))
          })
        }),
    }
    await a.node.start()
    for (let n = 0; n < 10; n += 1) {
      const ik = newKeyPair()
      const cert = signCert(ik, newKeyPair().pk, 1, 'x')
      await a.node.addContact(await encodeCard(makeCard(ik, [cert], `P${n}`, 'chat.example')))
    }
    for (let round = 0; round < 60 && release.length; round += 1) {
      release.splice(0).forEach(r => r())
      await settle()
    }
    expect(peak).toBe(LIMITS.inFlight)
    // Everyone backs off now: no new dials until the first backoff passes.
    const before = live
    await clock.advance(LIMITS.backoff[0] - 1000)
    expect(live).toBe(before)
    await clock.advance(LIMITS.tickMs + 2000)
    expect(live > 0).toBe(true)
    release.splice(0).forEach(r => r())
    await settle()
  })

  test('pause closes sessions, resume reconnects; hidden for 5 minutes pauses', async () => {
    const clock = new ManualClock()
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
    const hub = new Hub()
    const a = await makeNode(hub, 'Alice', { clock, visibility })
    const b = await makeNode(hub, 'Bob', { clock })
    nodes.push(a.node, b.node)
    await a.node.start()
    await b.node.start()
    await befriend(a.node, b.node, clock)
    await a.node.setPaused(true)
    await waitFor(() => a.node.status === 'paused', 'paused')
    await waitFor(() => b.node.presence(a.node.ik) === 'offline', 'offline at Bob')
    expect(hub.online(a.node.peerId)).toBe(false)
    await a.node.setPaused(false)
    await waitFor(() => a.node.presence(b.node.ik) === 'online', 'presence after resume')

    visible = false
    fns.forEach(f => f())
    await clock.advance(LIMITS.hiddenPauseMs + 1000)
    await waitFor(() => a.node.status === 'paused', 'hidden pause')
    await waitFor(() => b.node.presence(a.node.ik) === 'offline', 'offline while hidden')
    visible = true
    fns.forEach(f => f())
    await waitFor(() => a.node.presence(b.node.ik) === 'online', 'presence when visible')
    expect(a.node.status).toBe('online')
    // The user's pause survives a reload.
    expect(a.node.paused).toBe(false)
  })

  test("a node's own limits apply to it alone", async () => {
    const clock = new ManualClock()
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
    const hub = new Hub()
    const a = await makeNode(hub, 'Alice', {
      clock,
      visibility,
      limits: { hiddenPauseMs: 60_000 },
      session: { pingMs: 7000 },
    })
    const b = await makeNode(hub, 'Bob', { clock })
    nodes.push(a.node, b.node)
    expect(a.node.limits.hiddenPauseMs).toBe(60_000)
    expect(b.node.limits.hiddenPauseMs).toBe(LIMITS.hiddenPauseMs)
    expect(LIMITS.hiddenPauseMs).toBe(5 * 60_000)
    await a.node.start()
    await b.node.start()
    await befriend(a.node, b.node, clock)
    const s = a.node.readySessions(b.node.ik)[0] as unknown as { limits: { pingMs: number } }
    expect(s.limits.pingMs).toBe(7000)
    visible = false
    fns.forEach(f => f())
    await clock.advance(60_000 + 1000)
    await waitFor(() => a.node.status === 'paused', 'hidden pause after a minute')
  })

  test('a peer that fails handshakes is refused for a minute', async () => {
    const { out, hub } = await setup(['Alice'])
    const a = out[0].node
    const t = hub.transport()
    for (let n = 0; n < 3; n += 1) {
      const pipe = await t.dial('rcp-attacker', a.peerId)
      pipe.send(new Uint8Array([1, 0, 0, 0, 1, 0]))
      await waitFor(() => (pipe as unknown as { closed: boolean }).closed, 'a failed handshake')
    }
    const pipe = (await t.dial('rcp-attacker', a.peerId)) as unknown as { closed: boolean }
    expect(pipe.closed).toBe(true)
    void keyId
  })

  test("a fellow member's revoked device is refused, and a moved one hears where it went", async () => {
    const { out, clock } = await setup(['Alice', 'Mallory'])
    const [a, m] = out.map(x => x.node)
    const mSelf = (m as unknown as { self: SelfRecord }).self
    let revs: ReturnType<typeof signRevocation>[] = []
    // Not a contact: a fellow member the server extension wants, and knows the devices of.
    a.use({
      attach: () => {},
      ready: () => {},
      wanted: () => true,
      devices: ik => (ik === m.ik ? { certs: [mSelf.cert], revocations: revs } : null),
    })
    expect(await m.dialPeer(a.peerId, {})).not.toBeNull()
    await waitFor(() => a.readySessions(m.ik).length === 1, 'member session')
    for (const x of a.readySessions(m.ik)) x.close('closed')
    await waitFor(() => m.readySessions(a.ik).length === 0, 'closed on both sides')
    revs = [signRevocation(mSelf.ik, m.dk, clock.now())]
    const refused = await new Promise<string | null>(resolve => {
      void m.dialPeer(a.peerId, {}).then(s => {
        if (!s) return resolve(null)
        s.onClose((_, why) => resolve(why))
        if (s.state === 'closed') resolve(s.reason)
      })
    })
    expect(refused === null || refused === 'remote').toBe(true)
    expect(a.readySessions(m.ik)).toEqual([])
    // Moved to a new device: let through only to hear that.
    revs = [signRevocation(mSelf.ik, m.dk, clock.now(), keyId(newKeyPair().pk))]
    await m.dialPeer(a.peerId, {})
    await waitFor(() => m.status === 'moved', 'told it moved')
    expect(a.readySessions(m.ik)).toEqual([])
  })

  test('failed handshakes of peer ids that never come back are forgotten', async () => {
    const { out, clock } = await setup(['Alice'])
    const a = out[0].node
    const failed = (a as unknown as { failed: Map<string, number[]> }).failed
    const banned = (a as unknown as { banned: Map<string, number> }).banned
    for (let n = 0; n < 500; n += 1) failed.set(`rcp-gone-${n}`, [clock.now()])
    banned.set('rcp-banned', clock.now() + 1000)
    failed.set('rcp-recent', [clock.now() + 50_000])
    await clock.advance(60_000 + LIMITS.tickMs)
    expect([...failed.keys()]).toEqual(['rcp-recent'])
    expect(banned.size).toBe(0)
  })

  test('a revoked device is refused even when its hello leaves the revocation out', async () => {
    const { out, clock, hub } = await setup(['Alice', 'Bob'])
    const [a, b] = out.map(x => x.node)
    await befriend(a, b, clock)
    // Bob moves to a phone and revokes this browser's device key.
    const bSelf = (b as unknown as { self: SelfRecord }).self
    const oldDk = b.dk
    const dk2 = newKeyPair()
    const cert2 = signCert(bSelf.ik, dk2.pk, clock.now(), 'Phone')
    const rev = signRevocation(bSelf.ik, oldDk, clock.now(), keyId(dk2.pk))
    const phone = await P2pStore.open(`phone-${Math.random()}`)
    await phone.putSelf({ ...bSelf, dk: dk2, cert: cert2, certs: [cert2], revocations: [rev] })
    await phone.putContact((await out[1].store.contact(a.ik))!)
    const b2 = (await P2pNode.open({
      store: phone,
      transport: hub.transport(),
      host: 'chat.example',
      clock,
    })) as P2pNode
    nodes.push(b2)
    b.stop()
    await waitFor(() => a.presence(b.ik) === 'offline', 'the old device offline')
    await b2.start()
    await waitFor(() => a.presence(b.ik) === 'online', 'the phone online')
    expect(a.contact(b.ik)?.revocations.map(r => r.dk)).toEqual([oldDk])
    expect(a.contact(b.ik)?.certs.map(c => c.dk)).toEqual([keyId(dk2.pk)])
    b2.stop()
    await waitFor(() => a.presence(b.ik) === 'offline', 'the phone offline')

    // The stolen old browser comes back; its hello has no revocations.
    expect(bSelf.revocations).toEqual([])
    await b.start()
    b.schedule(true)
    await settle()
    await clock.advance(LIMITS.backoff[0] + LIMITS.tickMs)
    expect(a.presence(b.ik)).toBe('offline')
    expect(a.contact(b.ik)?.certs.some(c => c.dk === oldDk)).toBe(false)
    expect((await out[0].store.contact(b.ik))?.certs.some(c => c.dk === oldDk)).toBe(false)
  })

  test('a revocation in a new device hello ends the revoked device session', async () => {
    const { out, clock, hub } = await setup(['Alice', 'Bob'])
    const [a, b] = out.map(x => x.node)
    await befriend(a, b, clock)
    const bSelf = (b as unknown as { self: SelfRecord }).self
    const oldDk = b.dk
    const dk2 = newKeyPair()
    const cert2 = signCert(bSelf.ik, dk2.pk, clock.now(), 'Phone')
    const rev = signRevocation(bSelf.ik, oldDk, clock.now(), keyId(dk2.pk))
    const phone = await P2pStore.open(`phone-${Math.random()}`)
    await phone.putSelf({ ...bSelf, dk: dk2, cert: cert2, certs: [cert2], revocations: [rev] })
    await phone.putContact((await out[1].store.contact(a.ik))!)
    const b2 = (await P2pNode.open({
      store: phone,
      transport: hub.transport(),
      host: 'chat.example',
      clock,
    })) as P2pNode
    nodes.push(b2)
    const live = (a as unknown as { sessions: Map<string, unknown> }).sessions
    expect(live.has(oldDk)).toBe(true)
    await b2.start()
    b2.schedule(true)
    await waitFor(() => live.has(keyId(dk2.pk)), 'the phone session')
    await waitFor(() => !live.has(oldDk), 'the old device dropped')
    expect(a.presence(b.ik)).toBe('online')
  })

  test('a stale second instance cannot undo a block or write an old identity back', async () => {
    const { out, clock, hub } = await setup(['Alice', 'Bob'])
    const [a, b] = out.map(x => x.node)
    await befriend(a, b, clock)
    // A second tab on the same database, loaded before the changes below.
    const store2 = await P2pStore.open(out[0].db)
    const stale = (await P2pNode.open({
      store: store2,
      transport: hub.transport(),
      host: 'chat.example',
      clock,
    })) as P2pNode
    nodes.push(stale)
    expect(stale.contact(b.ik)?.state).toBe('mutual')
    await a.block(b.ik)
    await stale.rename(b.ik, 'Bobby')
    const stored = await out[0].store.contact(b.ik)
    expect(stored?.state).toBe('blocked')
    expect(stored?.petname).toBe('Bobby')
    expect(stale.contact(b.ik)?.state).toBe('blocked')

    const before = a.ik
    await a.resetIdentity()
    expect(a.ik === before).toBe(false)
    let err = ''
    await stale.setName('Old tab').catch((e: Error) => (err = e.message))
    expect(err).toBe(ELSEWHERE)
    const self = await out[0].store.self()
    expect(keyId(self!.ik.pk)).toBe(a.ik)
    expect(self!.profile.name).toBe('Alice')
    store2.close()
  })

  test('a claimed name change is checked against other contacts', async () => {
    const { out, clock } = await setup(['Alice', 'Bob', 'Carol'])
    const [a, b, c] = out.map(x => x.node)
    await befriend(a, b, clock)
    await befriend(a, c, clock)
    expect(a.contact(c.ik)?.warning).toBeNull()
    await c.setName('B\u043eb')
    await waitFor(() => a.contact(c.ik)?.name === 'B\u043eb', 'the new profile')
    expect(a.contact(c.ik)?.warning).toBe(b.ik)
    // It stays after another rename, until Alice verifies Carol.
    await c.setName('Carol')
    await waitFor(() => a.contact(c.ik)?.name === 'Carol', 'the second profile')
    expect(a.contact(c.ik)?.warning).toBe(b.ik)
    await a.markVerified(c.ik)
    expect(a.contact(c.ik)?.warning).toBeNull()
  })

  test('requests are capped and rate limited across identities', async () => {
    const saved = { ...LIMITS }
    LIMITS.requests = 2
    LIMITS.requestsPerHour = 3
    try {
      const { out, clock } = await setup(['Alice', 'E1', 'E2', 'E3', 'E4'])
      const [a, ...es] = out.map(x => x.node)
      const card = await a.myCard()
      for (const e of es.slice(0, 3)) {
        await clock.advance(1000)
        await e.addContact(card, `hi from ${e.name}`)
        await waitFor(() => a.view().contacts.length + a.view().dropped >= 1 + es.indexOf(e))
      }
      // The oldest unverified request made room; the newest are kept.
      expect(requests(a.view().contacts).map(c => c.ik)).toEqual([es[2].ik, es[1].ik])
      expect(a.view().dropped).toBe(1)
      // A fourth new identity within the hour is turned away.
      await es[3].addContact(card, 'and me')
      await waitFor(() => a.view().dropped === 2, 'the rate limit')
      expect(a.contact(es[3].ik)).toBeUndefined()
      await a.clearDropped()
      expect(a.view().dropped).toBe(0)
    } finally {
      Object.assign(LIMITS, saved)
    }
  })

  test('voice participants are dialed past the cap while a session can make room for them', async () => {
    const saved = { ...LIMITS }
    LIMITS.sessions = 1
    try {
      const { out, clock, hub } = await setup(['Alice', 'Bob', 'Carol'])
      const [a, b, c] = out.map(x => x.node)
      await befriend(a, b, clock)
      c.use({ attach: () => {}, ready: () => {}, wanted: () => true })
      let keepBob = true
      a.use({
        attach: () => {},
        ready: () => {},
        urgent: () => [{ ik: c.ik, certs: [c.cert] }],
        keep: s => (keepBob && s.remote?.ik === b.ik) || s.remote?.ik === c.ik,
        wanted: () => true,
      })
      // At the cap and Bob's session is in voice too: nothing may make room, nobody is dialed.
      const before = hub.dialCount
      a.schedule(true)
      await settle()
      expect(hub.dialCount).toBe(before)
      // Bob's isn't: Carol is dialed past the cap and Bob's session makes room.
      keepBob = false
      a.schedule(true)
      await waitFor(() => a.readySessions(c.ik).length === 1, 'the session with Carol')
      expect(a.readySessions(b.ik)).toEqual([])
    } finally {
      Object.assign(LIMITS, saved)
    }
  })

  test("a voice participant's device is dialed though a session with another of its devices is up", async () => {
    const { out, hub } = await setup(['Alice', 'Bob'])
    const [a, b] = out.map(x => x.node)
    // Bob's other device, as the participant's voice device would be named.
    const other = newKeyPair()
    const cert = signCert(newKeyPair(), other.pk, 1, 'test')
    let urgent = [{ ik: b.ik, certs: [b.cert] }]
    a.use({ attach: () => {}, ready: () => {}, urgent: () => urgent, wanted: () => true })
    b.use({ attach: () => {}, ready: () => {}, wanted: () => true })
    a.schedule(true)
    await waitFor(() => a.readySessions(b.ik).length === 1, 'the session with Bob')
    // A session with Bob's device is up: that device isn't dialed again, another one is.
    const before = hub.dialCount
    a.schedule(true)
    await settle()
    expect(hub.dialCount).toBe(before)
    urgent = [{ ik: b.ik, certs: [{ ...cert, ik: b.ik }] }]
    a.schedule(true)
    await settle()
    expect(hub.dialCount).toBeGreaterThan(before)
  })

  test('unauthenticated connections never push out established sessions', async () => {
    const saved = { ...LIMITS }
    LIMITS.sessions = 1
    try {
      const { out, clock, hub } = await setup(['Alice', 'Bob'])
      const [a, b] = out.map(x => x.node)
      await befriend(a, b, clock)
      const t = hub.transport()
      const pipes = []
      for (let n = 0; n < LIMITS.handshakes; n += 1)
        pipes.push((await t.dial(`rcp-probe${n}`, a.peerId)) as unknown as { closed: boolean })
      await settle()
      expect(pipes.every(p => !p.closed)).toBe(true)
      expect(a.presence(b.ik)).toBe('online')
      // The handshake pool is full: the next one is turned away at once.
      const extra = (await t.dial('rcp-probe-x', a.peerId)) as unknown as { closed: boolean }
      expect(extra.closed).toBe(true)
      expect(a.presence(b.ik)).toBe('online')
    } finally {
      Object.assign(LIMITS, saved)
    }
  })

  test('sessions that never send a hello free their handshake slots', async () => {
    const { out, clock, hub } = await setup(['Alice', 'Bob'])
    const [a, b] = out.map(x => x.node)
    const t = hub.transport()
    const probes: Session[] = []
    for (let n = 0; n < LIMITS.handshakes; n += 1) {
      const ik = newKeyPair()
      const dk = newKeyPair()
      const me = { ik, dk, cert: signCert(ik, dk.pk, 1, 'test'), peer: peerId(dk.pk) }
      const pipe = await t.dial(me.peer, a.peerId)
      // Finishes SIGMA, then only pings.
      const s = new Session({
        role: 'initiator',
        pipe,
        me,
        clock,
        hello: () => ({ t: 'ping' }),
        onHello: () => true,
      })
      s.start()
      probes.push(s)
    }
    await waitFor(() => probes.every(s => s.state === 'ready'), 'probes past SIGMA')
    const extra = (await t.dial('rcp-probe-x', a.peerId)) as unknown as { closed: boolean }
    expect(extra.closed).toBe(true)
    await clock.advance(SESSION_LIMITS.handshakeMs + 1000)
    expect(probes.every(s => s.state === 'closed')).toBe(true)
    // A real contact gets through again.
    await befriend(b, a, clock)
  })

  test('refused sessions count as failed handshakes', async () => {
    const { out, clock, hub } = await setup(['Alice', 'Bob'])
    const [a, b] = out.map(x => x.node)
    await befriend(a, b, clock)
    await a.block(b.ik)
    await waitFor(() => b.presence(a.ik) === 'offline', 'offline after block')
    const dial = (b as unknown as { dial: (c: unknown) => Promise<void> }).dial.bind(b)
    for (let n = 0; n < LIMITS.failedHandshakes; n += 1) await dial(b.contact(a.ik))
    const probe = (await hub.transport().dial(b.peerId, a.peerId)) as unknown as {
      closed: boolean
    }
    expect(probe.closed).toBe(true)
  })
})

// Web Locks and BroadcastChannel stand-ins: one lock name, steal and abort supported.
class FakeLocks implements LockLike {
  held: { done: boolean; reject: (e: Error) => void } | null = null
  private waiting: {
    cb: (l: unknown) => Promise<unknown>
    resolve: (v: unknown) => void
    reject: (e: Error) => void
    done: boolean
  }[] = []

  request(
    _name: string,
    opts: { signal?: AbortSignal; ifAvailable?: boolean; steal?: boolean },
    cb: (lock: unknown) => Promise<unknown>
  ) {
    return new Promise<unknown>((resolve, reject) => {
      const e = { cb, resolve, reject, done: false }
      if (opts.steal) {
        const old = this.held
        if (old) {
          old.done = true
          old.reject(new Error('AbortError'))
        }
        this.held = null
        return this.grant(e)
      }
      if (!this.held && this.waiting.length === 0) return this.grant(e)
      if (opts.ifAvailable) return void cb(null).then(resolve, reject)
      this.waiting.push(e)
      opts.signal?.addEventListener('abort', () => {
        const i = this.waiting.indexOf(e)
        if (i < 0) return
        this.waiting.splice(i, 1)
        reject(new Error('AbortError'))
      })
    })
  }

  private grant(e: (typeof this.waiting)[number]) {
    this.held = e
    const finish = (settle: () => void) => {
      if (e.done) return
      e.done = true
      settle()
      if (this.held !== e) return
      this.held = null
      const next = this.waiting.shift()
      if (next) this.grant(next)
    }
    void Promise.resolve()
      .then(() => e.cb({}))
      .then(
        v => finish(() => e.resolve(v)),
        err => finish(() => e.reject(err))
      )
  }
}

const bus = () => {
  const chans = new Set<ChannelLike>()
  return (): ChannelLike => {
    const c: ChannelLike = {
      onmessage: null,
      postMessage: msg => {
        for (const o of chans) if (o !== c) queueMicrotask(() => o.onmessage?.({ data: msg }))
      },
      close: () => void chans.delete(c),
    }
    chans.add(c)
    return c
  }
}

const hookTab = (
  locks: LockLike | null,
  channel: (name: string) => ChannelLike | null,
  clock: ManualClock
) => {
  const log: string[] = []
  const leader = new TabLeader(
    'db',
    {
      lead: async () => void log.push('lead'),
      resign: async () => void log.push('resign'),
      follow: () => void log.push('follow'),
    },
    { locks, channel, set: (fn, ms) => clock.set(fn, ms), clear: h => clock.clear(h) }
  )
  return { log, leader }
}

describe('tab leader', () => {
  test('a holder that never answers loses the lock after the wait, then waits in line', async () => {
    const locks = new FakeLocks()
    const clock = new ManualClock()
    const frozen: ChannelLike = { onmessage: null, postMessage: () => {}, close: () => {} }
    const one = hookTab(locks, () => frozen, clock)
    const two = hookTab(locks, bus(), clock)
    one.leader.start()
    await waitFor(() => one.leader.state === 'leading', 'one leads')
    two.leader.start()
    await waitFor(() => two.log.includes('follow'), 'two follows')
    two.leader.takeOver()
    await settle()
    expect(two.leader.state).toBe('waiting')
    await clock.advance(HANDOVER_MS)
    await waitFor(() => two.leader.state === 'leading', 'taken')
    await waitFor(() => one.leader.state === 'waiting', 'one lost it')
    expect(one.log).toEqual(['lead', 'resign', 'follow'])
    expect(two.log).toEqual(['follow', 'lead'])
    // The one that took it closes: the other is next in line.
    await two.leader.stop()
    await waitFor(() => one.leader.state === 'leading', 'one again')
    expect(one.log.at(-1)).toBe('lead')
    await one.leader.stop()
  })

  test('without Web Locks the tab runs the node itself', async () => {
    const t = hookTab(null, () => null, new ManualClock())
    t.leader.start()
    await settle()
    expect(t.leader.state).toBe('leading')
    t.leader.takeOver()
    await settle()
    expect(t.log).toEqual(['lead'])
    await t.leader.stop()
    expect(t.log).toEqual(['lead', 'resign'])
  })
})

describe('one P2P node per database across tabs', () => {
  test('the second tab waits; Use here moves the node cleanly; closing hands it back', async () => {
    const hub = new Hub()
    const clock = new ManualClock()
    const first = await makeNode(hub, 'Alice', { clock })
    const db = first.db
    const ik = first.node.ik
    first.store.close()
    const locks = new FakeLocks()
    const channel = bus()
    const tab = (name: string) => {
      const t = {
        node: null as P2pNode | null,
        store: null as P2pStore | null,
        following: false,
        leader: null as unknown as TabLeader,
      }
      t.leader = new TabLeader(
        db,
        {
          lead: async () => {
            t.following = false
            t.store = await P2pStore.open(db)
            t.node = (await P2pNode.open({
              store: t.store,
              transport: hub.transport(),
              host: 'chat.example',
              clock,
              label: name,
            })) as P2pNode
            await t.node.start()
          },
          resign: async () => {
            t.node?.stop()
            t.store?.close()
            t.node = null
            t.store = null
          },
          follow: () => {
            t.following = true
          },
        },
        {
          locks,
          channel,
          set: (fn, ms) => setTimeout(fn, ms),
          clear: h => clearTimeout(h as never),
        }
      )
      return t
    }
    const one = tab('one')
    const two = tab('two')
    one.leader.start()
    await waitFor(() => one.node?.status === 'online', 'tab one online')
    two.leader.start()
    await waitFor(() => two.following, 'tab two following')
    expect(two.node).toBeNull()
    expect(one.node?.ik).toBe(ik)

    two.leader.takeOver()
    await waitFor(() => two.node?.status === 'online', 'tab two online')
    expect(one.node).toBeNull()
    expect(one.following).toBe(true)
    // Tab one let go of the peer id before tab two listened, so no suffix was needed.
    expect(two.node?.peerId).toBe(peerId(two.node!.dk))
    expect(two.node?.ik).toBe(ik)

    // Tab two closes: tab one, waiting in line, takes over by itself.
    await two.leader.stop()
    await waitFor(() => one.node?.status === 'online', 'tab one back')
    expect(one.node?.peerId).toBe(peerId(one.node!.dk))
    await one.leader.stop()
    expect(one.node).toBeNull()
  })
})

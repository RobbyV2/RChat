import { afterEach, describe, expect, test } from 'bun:test'
import { Hub, makeNode, ManualClock, settle, waitFor } from './p2p_net'
import { OFFER_SKEW_MS, type OfferGuard, type OfferProof, type P2pNode } from '../p2p/node'
import {
  CHECKS_PER_MIN,
  HELD_PER_PEER,
  OfferGate,
  PeerTransport,
  answerConfig,
} from '../p2p/transport'
import { PROMPTS, RelayBook, defaultRelays, relayBook, type Decision } from '../relays'
import { ice } from '../ice'

// Offers that declare relays we don't know (transport I3): only a signed device of someone we
// would talk to may cause a relay prompt, a few at most.

const nodes: P2pNode[] = []
afterEach(() => {
  for (const n of nodes.splice(0)) n.stop()
})

const guardOf = (n: P2pNode): OfferGuard => {
  const x = n as unknown as {
    vouch: OfferGuard['vouch']
    offerFrom: OfferGuard['sender']
  }
  return {
    vouch: (from, to, relays) => x.vouch(from, to, relays),
    sender: (src, proof, relays) => x.offerFrom(src, proof, relays),
  }
}

const book = (answers: Decision[] = []) => {
  const b = new RelayBook(() => ({
    instance: [],
    helpers: true,
    relayOnly: false,
    instanceTurn: false,
    forced: null,
  }))
  const asked: string[] = []
  b.prompt = async host => {
    asked.push(host)
    return answers.shift() ?? 'deny'
  }
  return { b, asked }
}

const setup = async () => {
  const clock = new ManualClock()
  const hub = new Hub()
  const make = async (name: string) => {
    const n = (await makeNode(hub, name, { clock })).node
    nodes.push(n)
    await n.start()
    return n
  }
  const alice = await make('Alice')
  const bob = await make('Bob')
  const mallory = await make('Mallory')
  for (const other of [bob, mallory]) {
    expect((await other.addContact(await alice.myCard())).ok).toBe(true)
    await waitFor(() => alice.contact(other.ik)?.state === 'incoming', 'request')
    await alice.accept(other.ik)
  }
  return { clock, alice, bob, mallory, make }
}

// An offer from `from` to `to` declaring `relays`, as the transport sends it.
const offerOf = (from: P2pNode, to: P2pNode, relays: string[], proof?: OfferProof | null) => ({
  src: from.peerId,
  meta: {
    relays,
    ...(proof === null
      ? {}
      : { ask: proof ?? guardOf(from).vouch(from.peerId, to.peerId, relays) }),
  },
})

describe('relay prompts from offers', () => {
  test('a contact asks once per answer; a Deny is kept for that list', async () => {
    const { alice, bob } = await setup()
    const { b, asked } = book(['once', 'deny'])
    const gate = new OfferGate(b, () => guardOf(alice))
    let answered = 0
    const send = async (relays: string[]) => {
      const o = offerOf(bob, alice, relays)
      gate.offer(o.src, o.meta, () => (answered += 1))
      await settle()
    }
    await send(['turn.bob.example'])
    expect([asked.length, answered]).toEqual([1, 1])
    // Allowed a moment ago: the next connection goes through without a second prompt.
    await send(['turn.bob.example'])
    expect([asked.length, answered]).toEqual([1, 2])
    await send(['turn.other.example'])
    expect([asked.length, answered]).toEqual([2, 2])
    await send(['turn.other.example'])
    expect([asked.length, answered]).toEqual([2, 2])
    // Nothing to ask about: answered at once.
    gate.offer(bob.peerId, { relays: [] }, () => (answered += 1))
    expect(answered).toBe(3)
  })

  test('a blocked contact, a stranger without a proof and forged proofs raise no prompt', async () => {
    const { clock, alice, bob, mallory, make } = await setup()
    const { b, asked } = book(['once', 'once', 'once', 'once'])
    const gate = new OfferGate(b, () => guardOf(alice))
    let answered = 0
    const offer = async (o: { src: string; meta: unknown }) => {
      gate.offer(o.src, o.meta, () => (answered += 1))
      await settle()
    }
    await alice.block(mallory.ik)
    await offer(offerOf(mallory, alice, ['turn.m.example']))
    // No proof (an older or a forged offer), a proof for someone else, from another device, old.
    await offer(offerOf(bob, alice, ['turn.b.example'], null))
    const carol = await make('Carol')
    await offer(
      offerOf(
        bob,
        alice,
        ['turn.b.example'],
        guardOf(bob).vouch(bob.peerId, carol.peerId, ['turn.b.example'])
      )
    )
    await offer({ src: carol.peerId, meta: offerOf(bob, alice, ['turn.b.example']).meta })
    await offer(
      offerOf(
        bob,
        alice,
        ['turn.c.example'],
        guardOf(bob).vouch(bob.peerId, alice.peerId, ['turn.b.example'])
      )
    )
    const stale = guardOf(bob).vouch(bob.peerId, alice.peerId, ['turn.b.example'])
    clock.t += OFFER_SKEW_MS + 1000
    await offer(offerOf(bob, alice, ['turn.b.example'], stale))
    await offer({ src: bob.peerId, meta: { relays: ['bad host!'], ask: stale } })
    expect(asked).toEqual([])
    expect(answered).toBe(0)
    // A stranger's device is unknown here, good signature or not: no prompt.
    await offer(offerOf(carol, alice, ['turn.c.example']))
    expect(asked).toEqual([])
    // A device we know of a fellow server member may ask, while they are one.
    let member = false
    alice.use({
      attach: () => {},
      ready: () => {},
      owner: dk => (dk === carol.dk ? carol.ik : null),
      member: ik => member && ik === carol.ik,
    })
    await offer(offerOf(carol, alice, ['turn.c.example']))
    expect(asked).toEqual([])
    member = true
    await offer(offerOf(carol, alice, ['turn.c.example']))
    expect(asked).toEqual(['turn.c.example'])
    expect(answered).toBe(1)
  })

  test('the offer data names no identity: no identity key, no certificate', async () => {
    const { alice, bob } = await setup()
    const t = new PeerTransport()
    t.guard(guardOf(bob))
    const sent: unknown[] = []
    const handlers = new Map<string, () => void>()
    const conn = { on: (ev: string, fn: () => void) => void handlers.set(ev, fn), close: () => {} }
    ;(t as unknown as { peer: unknown }).peer = {
      destroyed: false,
      connect: (_to: string, o: { metadata: unknown }) => {
        sent.push(o.metadata)
        return conn
      },
      on: () => {},
      off: () => {},
    }
    const helpers = ice.helpersOn()
    ice.setHelpers(true)
    relayBook.save({ ...defaultRelays(), relays: [{ url: `${'turn'}:turn.bob.example` }] })
    try {
      const dialed = t.dial(bob.peerId, alice.peerId).catch(() => null)
      handlers.get('close')?.()
      await dialed
    } finally {
      relayBook.load(null)
      ice.setHelpers(helpers)
    }
    expect(sent.length).toBe(1)
    const meta = sent[0] as { relays: string[]; ask: Record<string, unknown> }
    expect(meta.relays).toEqual(['turn.bob.example'])
    expect(Object.keys(meta.ask).sort()).toEqual(['dk', 'sig', 'ts'])
    expect(meta.ask.dk).toBe(bob.dk)
    const text = JSON.stringify(meta)
    expect(text.includes(bob.ik)).toBe(false)
    expect(text.includes('"cert"') || text.includes('"ik"')).toBe(false)
    // Alice still knows who it is: her contact Bob's device.
    expect(guardOf(alice).sender(bob.peerId, meta.ask, meta.relays)).toBe(bob.ik)
  })

  test('20 offers with fresh hosts from one peer raise at most its share of prompts', async () => {
    const { alice, mallory } = await setup()
    const { b, asked } = book()
    const gate = new OfferGate(b, () => guardOf(alice))
    for (let i = 0; i < 20; i++) {
      const o = offerOf(mallory, alice, [`h${i}.example`])
      gate.offer(o.src, o.meta, () => {})
      await settle(5)
    }
    expect(asked.length).toBe(PROMPTS.perPeer)
  })

  test('held offers and proof checks are capped', async () => {
    const { alice, bob } = await setup()
    const { b, asked } = book()
    const waiting: ((d: Decision) => void)[] = []
    b.prompt = host => {
      asked.push(host)
      return new Promise(r => waiting.push(r))
    }
    let now = 0
    const gate = new OfferGate(
      b,
      () => guardOf(alice),
      () => now
    )
    let answered = 0
    for (let i = 0; i < 3; i++) {
      const o = offerOf(bob, alice, [`h${i}.example`])
      gate.offer(o.src, o.meta, () => (answered += 1))
    }
    await settle()
    expect(waiting.length).toBe(HELD_PER_PEER)
    waiting[0]('once')
    await settle()
    expect(answered).toBe(1)
    let checked = 0
    const counting = new OfferGate(
      b,
      () => ({
        ...guardOf(alice),
        sender: () => {
          checked += 1
          return null
        },
      }),
      () => now
    )
    for (let i = 0; i < CHECKS_PER_MIN * 2; i++)
      counting.offer(bob.peerId, { relays: ['x.example'] }, () => {})
    expect(checked).toBe(CHECKS_PER_MIN)
    now += 60_000
    counting.offer(bob.peerId, { relays: ['x.example'] }, () => {})
    expect(checked).toBe(CHECKS_PER_MIN + 1)
  })

  test('without the offer hook, connections use relays only while asking is on', () => {
    const { b } = book()
    expect(answerConfig(true, b).iceTransportPolicy).toBeUndefined()
    expect(answerConfig(false, b).iceTransportPolicy).toBe('relay')
    b.prefs = { ...b.prefs, ask: false }
    expect(answerConfig(false, b).iceTransportPolicy).toBeUndefined()
  })
})

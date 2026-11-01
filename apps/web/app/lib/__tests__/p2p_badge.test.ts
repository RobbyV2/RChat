import { afterEach, describe, expect, test } from 'bun:test'
import {
  SignJWT,
  calculateJwkThumbprint,
  exportJWK,
  generateKeyPair,
  type CryptoKey,
  type JSONWebKeySet,
  type JWK,
} from 'jose'
import { Hub, makeNode, ManualClock, settle, waitFor } from './p2p_net'
import { joinWithCode, makeMember, pump, stopAll } from './p2p_server_net'
import {
  AssertionError,
  BINDING_AUD,
  BINDING_MAX_TTL,
  verifyBinding,
  type BindingClaims,
} from '../identity'
import {
  accountTwin,
  applyVerdict,
  BADGE,
  BadgeKeeper,
  Badges,
  badgeState,
  emptySlot,
  memberBindingDue,
  parseSlot,
  readSlots,
  type BadgeSlot,
  type Issued,
} from '../p2p/badge'
import { P2pStore } from '../p2p/db'
import { bindingMessage, bindingProof, keyId, newKeyPair, publicOf } from '../p2p/keys'
import { utf8 } from '../p2p/canonical'
import type { P2pNode } from '../p2p/node'
import type { Contact } from '../p2p/contacts'

const ISS = 'https://chat.example'
const HOST = 'chat.example'

interface Key {
  jwk: JWK
  priv: CryptoKey
}

const newKey = async (): Promise<Key> => {
  const { publicKey, privateKey } = await generateKeyPair('EdDSA', { extractable: true })
  const jwk = await exportJWK(publicKey)
  jwk.kid = await calculateJwkThumbprint(jwk)
  jwk.alg = 'EdDSA'
  jwk.use = 'sig'
  return { jwk, priv: privateKey }
}

// What the instance would sign for `ik` at `ms` (the test clock).
const issue = (
  key: Key,
  ik: string,
  ms: number,
  over: { sub?: string; aud?: string; ttl?: number } = {}
) => {
  const iat = Math.floor(ms / 1000)
  return new SignJWT({ sub: over.sub ?? `alice@${HOST}`, ik })
    .setProtectedHeader({ alg: 'EdDSA', typ: 'JWT', kid: key.jwk.kid })
    .setIssuer(ISS)
    .setAudience(over.aud ?? BINDING_AUD)
    .setIssuedAt(iat)
    .setExpirationTime(iat + (over.ttl ?? BINDING_MAX_TTL))
    .sign(key.priv)
}

const nodes: P2pNode[] = []
const badgeSets: Badges[] = []
afterEach(() => {
  for (const n of nodes.splice(0)) n.stop()
  for (const b of badgeSets.splice(0)) b.stop()
  stopAll()
})

const DAY = 24 * 60 * 60_000

// Moves the clock on without replaying every timer in between (node and badge ticks would run
// thousands of times): what is due runs once.
const jump = async (clock: ManualClock, ms: number) => {
  clock.t += ms
  await clock.advance(1)
}

describe('binding proof', () => {
  test('the message and the proof match the Rust vectors', () => {
    const sk = new Uint8Array(32).fill(7)
    const ik = { sk, pk: publicOf(sk) }
    expect(keyId(ik.pk)).toBe('6kpsY-KcUgq-9VB7Ey7F-ZVHdq6-vnuSQh7qaRRG0iw')
    expect(bindingMessage('alice@chat.example', 1793056306)).toEqual(
      utf8('rchat-p2p-bind1\0alice@chat.example\u00001793056306')
    )
    expect(bindingProof(ik, 'alice@chat.example', 1793056306)).toBe(
      '8U4Mtq2GXpao_qppPrPJ0hRcVcGtMYUcmpNk-KubIef9gx8k0kdgWwhUw8QN60CtMhcnbNL09X7RJ3TLJn0xAA'
    )
  })
})

const claims = (over: Partial<BindingClaims> = {}): BindingClaims => ({
  iss: ISS,
  sub: `alice@${HOST}`,
  aud: BINDING_AUD,
  ik: 'x',
  iat: 1000,
  exp: 1000 + BINDING_MAX_TTL,
  ...over,
})

describe('badge states', () => {
  test('confirmed until it expires, unchecked while the issuer is away, dropped when refused', () => {
    const ik = keyId(newKeyPair().pk)
    const now = 2000_000
    const ok = applyVerdict(emptySlot(ik), 't1', { kind: 'ok', claims: claims() }, now)
    expect(badgeState(ok, now)).toBe('confirmed')
    expect(ok.ok?.checked).toBe(now)
    expect(badgeState(ok, (1000 + BINDING_MAX_TTL) * 1000 + 1)).toBe('expired')
    // A re-check the issuer can't answer keeps the last result and its date.
    const away = applyVerdict(ok, 't1', { kind: 'unreachable' }, now + DAY)
    expect(badgeState(away, now + DAY)).toBe('confirmed')
    expect(away.ok?.checked).toBe(now)
    expect(away.ok?.tried).toBe(now + DAY)
    // A first token the issuer can't answer: "Couldn't check".
    const first = applyVerdict(emptySlot(ik), 't1', { kind: 'unreachable' }, now)
    expect(badgeState(first, now)).toBe('unchecked')
    expect(badgeState(applyVerdict(first, 't1', { kind: 'bad' }, now), now)).toBeNull()
    // The issuer no longer vouches for the one held (its key was withdrawn).
    expect(applyVerdict(ok, 't1', { kind: 'bad' }, now).ok).toBeNull()
    // A bad or expired other token changes nothing held.
    expect(applyVerdict(ok, 't2', { kind: 'bad' }, now).ok?.token).toBe('t1')
    expect(applyVerdict(ok, 't2', { kind: 'expired' }, now).ok?.token).toBe('t1')
    expect(applyVerdict(emptySlot(ik), 't2', { kind: 'expired' }, now).ok).toBeNull()
    // Newer replaces older, never the other way round.
    const newer = applyVerdict(ok, 't3', { kind: 'ok', claims: claims({ iat: 5000 }) }, now)
    expect(newer.ok?.token).toBe('t3')
    expect(
      applyVerdict(newer, 't1', { kind: 'ok', claims: claims({ iat: 1000 }) }, now).ok?.token
    ).toBe('t3')
    // An expired one with a newer token not checked yet: "Couldn't check".
    const late = applyVerdict(ok, 't4', { kind: 'unreachable' }, now)
    expect(badgeState(late, (1000 + BINDING_MAX_TTL) * 1000 + 1)).toBe('unchecked')
    expect(badgeState(late, now)).toBe('confirmed')
  })

  test('stored slots are read defensively', () => {
    const ik = keyId(newKeyPair().pk)
    expect(parseSlot(null)).toBeNull()
    expect(parseSlot({ ik: 'nope', ok: null, todo: { token: 't', tried: 1 } })).toBeNull()
    expect(parseSlot({ ik, ok: { token: 1 }, todo: null })).toBeNull()
    expect(parseSlot({ ik, ok: { token: 't' }, todo: { token: 't', tried: 1 } })).toEqual({
      ik,
      ok: null,
      todo: { token: 't', tried: 1 },
    })
  })

  test('a confirmed account an older contact has is a twin; the newer key gets the warning', () => {
    const a = keyId(newKeyPair().pk)
    const b = keyId(newKeyPair().pk)
    const contact = (ik: string, over: Partial<Contact> = {}) =>
      ({ ik, state: 'mutual', ignored: false, added: ik === a ? 1 : 2, ...over }) as Contact
    const ok = (ik: string) => applyVerdict(emptySlot(ik), 't', { kind: 'ok', claims: claims() }, 1)
    const slots = new Map<string, BadgeSlot>([[a, ok(a)]])
    const both = [contact(a), contact(b)]
    expect(accountTwin(both, slots, b, `Alice@${HOST}`)).toBe(a)
    expect(accountTwin(both, slots, b, `bob@${HOST}`)).toBeNull()
    expect(accountTwin(both, slots, a, `alice@${HOST}`)).toBeNull()
    // Not a contact (a server member): nobody to warn.
    expect(accountTwin([contact(a)], slots, b, `alice@${HOST}`)).toBeNull()
    expect(
      accountTwin([contact(a, { state: 'blocked' }), contact(b)], slots, b, `alice@${HOST}`)
    ).toBeNull()
    expect(
      accountTwin([contact(a, { ignored: true }), contact(b)], slots, b, `alice@${HOST}`)
    ).toBeNull()
    // Both confirmed as the same account: only the newer one is the twin of the older.
    slots.set(b, ok(b))
    expect(accountTwin(both, slots, b, `alice@${HOST}`)).toBe(a)
    expect(accountTwin(both, slots, a, `alice@${HOST}`)).toBeNull()
  })

  test('our member event is posted again for a badge turned on, or one with half its life left', async () => {
    const key = await newKey()
    const ik = keyId(newKeyPair().pk)
    const t0 = 1_800_000_000_000
    const fresh = await issue(key, ik, t0)
    const renewed = await issue(key, ik, t0 + DAY)
    expect(memberBindingDue(undefined, null, t0)).toBe(false)
    expect(memberBindingDue(fresh, null, t0)).toBe(false)
    expect(memberBindingDue(undefined, fresh, t0)).toBe(true)
    expect(memberBindingDue(7, fresh, t0)).toBe(true)
    expect(memberBindingDue('junk', fresh, t0)).toBe(true)
    expect(memberBindingDue(fresh, fresh, t0 + 6 * DAY)).toBe(false)
    expect(memberBindingDue(fresh, renewed, t0 + DAY)).toBe(false)
    expect(memberBindingDue(fresh, renewed, t0 + 3 * DAY)).toBe(false)
    expect(memberBindingDue(fresh, renewed, t0 + 4 * DAY)).toBe(true)
  })
})

const openStore = () => P2pStore.open(`badge-${Math.random()}`)

describe('Badges', () => {
  const setup = async (verify: (token: string, ik: string) => Promise<BindingClaims>) => {
    const clock = new ManualClock()
    const store = await openStore()
    const calls: string[] = []
    const warned: [string, string][] = []
    const contacts: Contact[] = []
    const b = new Badges({
      store,
      clock,
      verify: (t, ik) => {
        calls.push(t)
        return verify(t, ik)
      },
      contacts: () => contacts,
      warn: async (ik, other) => void warned.push([ik, other]),
    })
    badgeSets.push(b)
    await b.start()
    return { clock, store, b, calls, warned, contacts }
  }

  test('checks at receipt, again once a day old, and keeps the result across restarts', async () => {
    const key = await newKey()
    const keys: JSONWebKeySet = { keys: [key.jwk] }
    let clockNow = 0
    const { clock, store, b, calls } = await setup((t, ik) =>
      verifyBinding(t, { ik, keys, host: HOST, now: new Date(clockNow) })
    )
    clockNow = clock.now()
    const ik = keyId(newKeyPair().pk)
    const token = await issue(key, ik, clock.now())
    b.offer(ik, token)
    await waitFor(() => badgeState(b.get(ik), clock.now()) === 'confirmed', 'confirmed')
    expect(b.get(ik)?.ok?.sub).toBe(`alice@${HOST}`)
    // The same token again within the day: no new check.
    b.offer(ik, token)
    await settle()
    expect(calls.length).toBe(1)
    // A day later the next tick checks again.
    await jump(clock, DAY + BADGE.tickMs)
    clockNow = clock.now()
    await waitFor(() => calls.length === 2, 'the daily check')
    await waitFor(() => (b.get(ik)?.ok?.checked ?? 0) > DAY, 'checked again')
    // Another browser session reads what was checked.
    expect((await readSlots(store)).get(ik)?.ok?.token).toBe(token)
    // Past its expiry it shows as expired, and isn't checked again.
    await jump(clock, 7 * DAY)
    clockNow = clock.now()
    expect(badgeState(b.get(ik), clock.now())).toBe('expired')
    const n = calls.length
    await jump(clock, DAY + BADGE.tickMs)
    expect(calls.length).toBe(n)
    // Long expired: forgotten.
    await jump(clock, BADGE.keepExpiredMs)
    await waitFor(() => b.get(ik) === undefined, 'forgotten')
    expect((await readSlots(store)).has(ik)).toBe(false)
  }, 30_000)

  test("an unreachable issuer: Couldn't check, retried, then confirmed", async () => {
    let up = false
    const { clock, b, calls } = await setup(async (_t, ik) => {
      if (!up) throw new AssertionError('fetch')
      const iat = Math.floor(clock.now() / 1000)
      return claims({ ik, iat, exp: iat + BINDING_MAX_TTL })
    })
    const ik = keyId(newKeyPair().pk)
    b.offer(ik, 'tok')
    await waitFor(() => badgeState(b.get(ik), clock.now()) === 'unchecked', 'unchecked')
    // Offered again right away: not asked again.
    b.offer(ik, 'tok')
    await settle()
    expect(calls.length).toBe(1)
    up = true
    await jump(clock, BADGE.retryMs + BADGE.tickMs)
    await waitFor(() => badgeState(b.get(ik), clock.now()) === 'confirmed', 'confirmed')
    // The issuer goes away again: a stale re-check keeps "confirmed" with the old date.
    up = false
    const checked = b.get(ik)?.ok?.checked
    await jump(clock, DAY + BADGE.tickMs)
    await waitFor(() => (b.get(ik)?.ok?.tried ?? 0) > (checked ?? 0), 'tried')
    expect(badgeState(b.get(ik), clock.now())).toBe('confirmed')
    expect(b.get(ik)?.ok?.checked).toBe(checked as number)
  }, 30_000)

  test('confirmed before they became a contact (a server member): the warning still comes', async () => {
    const { clock, b, calls, warned, contacts } = await setup(async (_t, ik) => {
      const iat = Math.floor(clock.now() / 1000)
      return claims({ ik, iat, exp: iat + BINDING_MAX_TTL })
    })
    const old = keyId(newKeyPair().pk)
    const member = keyId(newKeyPair().pk)
    const contact = (ik: string, added: number) =>
      ({ ik, state: 'mutual', ignored: false, added, warning: null }) as unknown as Contact
    contacts.push(contact(old, 1))
    b.offer(old, 'old')
    b.offer(member, 'member')
    await waitFor(() => calls.length === 2 && !!b.get(member)?.ok, 'both confirmed')
    await settle()
    expect(warned).toEqual([])
    // The member sends a request: its hello carries the same, already checked binding.
    contacts.push(contact(member, 2))
    b.offer(member, 'member')
    await waitFor(() => warned.length === 1, 'warned')
    expect(warned).toEqual([[member, old]])
    expect(calls.length).toBe(2)
    // The older contact is never the one warned.
    b.offer(old, 'old')
    await settle()
    expect(warned.length).toBe(1)
  })

  test('refused tokens leave no badge and are not checked twice; junk is ignored', async () => {
    const { b, calls } = await setup(async () => {
      throw new AssertionError('ik')
    })
    const ik = keyId(newKeyPair().pk)
    b.offer(ik, 'bad')
    await waitFor(() => calls.length === 1, 'checked')
    await settle()
    expect(b.get(ik)).toBeUndefined()
    b.offer(ik, 'bad')
    for (const junk of [7, null, { t: 1 }, '', 'x'.repeat(BADGE.tokenMax + 1)]) b.offer(ik, junk)
    b.offer('not-a-key', 'other')
    await settle()
    expect(calls).toEqual(['bad'])
  })

  test('verifyBinding refusals (wrong ik, audience, issuer key, issuer, expiry) leave no badge', async () => {
    const key = await newKey()
    const stranger = await newKey()
    const clock0 = new ManualClock()
    const { b } = await setup((t, ik) =>
      verifyBinding(t, { ik, keys: { keys: [key.jwk] }, host: HOST, now: new Date(clock0.now()) })
    )
    const ik = keyId(newKeyPair().pk)
    const other = keyId(newKeyPair().pk)
    const t0 = clock0.now()
    const cases = [
      await issue(key, other, t0),
      await issue(key, ik, t0, { aud: 'https://b.example' }),
      await issue(stranger, ik, t0),
      await issue(key, ik, t0 - 8 * DAY),
      await issue(key, ik, t0, { sub: 'alice@evil.example' }),
    ]
    for (const t of cases) b.offer(ik, t)
    await settle(200)
    expect(b.get(ik)).toBeUndefined()
    b.offer(ik, await issue(key, ik, t0))
    await waitFor(() => badgeState(b.get(ik), t0) === 'confirmed', 'the good one')
  }, 30_000)
})

// Two nodes with badges checked against a local instance key, like the app wires them.
const withBadges = async (hub: Hub, name: string, clock: ManualClock, keys: JSONWebKeySet) => {
  const n = await makeNode(hub, name, { clock, host: HOST })
  nodes.push(n.node)
  const node = n.node
  const b = new Badges({
    store: n.store,
    clock,
    verify: (t, ik) => verifyBinding(t, { ik, keys, host: HOST, now: new Date(clock.now()) }),
    contacts: () => node.view().contacts,
    warn: (ik, other) => node.warnAccount(ik, other),
  })
  badgeSets.push(b)
  node.onBinding((ik, token) => b.offer(ik, token))
  await b.start()
  await node.start()
  return { node, badges: b, store: n.store }
}

const befriend = async (a: P2pNode, b: P2pNode) => {
  expect((await a.addContact(await b.myCard())).ok).toBe(true)
  await waitFor(() => b.contact(a.ik)?.state === 'incoming', 'the request')
  await b.accept(a.ik)
  await waitFor(() => a.presence(b.ik) === 'online' && b.presence(a.ik) === 'online', 'online')
}

const own = (token: string, ik: string, ms: number, sub = `alice@${HOST}`) => ({
  on: true,
  token,
  ik,
  sub,
  at: ms,
  exp: Math.floor(ms / 1000) + BINDING_MAX_TTL,
})

describe('badges over P2P', () => {
  test('in the hello and in profile frames; turned off, it stays until it expires', async () => {
    const key = await newKey()
    const keys = { keys: [key.jwk] }
    const clock = new ManualClock()
    const hub = new Hub()
    const alice = await withBadges(hub, 'Alice', clock, keys)
    const bob = await withBadges(hub, 'Bob', clock, keys)
    const a = alice.node
    await a.setBadge(own(await issue(key, a.ik, clock.now()), a.ik, clock.now()))
    expect(a.binding).not.toBeNull()
    await befriend(a, bob.node)
    // Carried by the hello.
    await waitFor(() => badgeState(bob.badges.get(a.ik), clock.now()) === 'confirmed', 'hello')
    expect(bob.badges.get(a.ik)?.ok?.sub).toBe(`alice@${HOST}`)
    // A renewed one goes out in a profile frame at once.
    const renewed = await issue(key, a.ik, clock.now() + 1000)
    await a.setBadge(own(renewed, a.ik, clock.now()))
    await waitFor(() => bob.badges.get(a.ik)?.ok?.token === renewed, 'profile frame')
    // Turned off: Alice stops sending it; Bob keeps the last one until it expires.
    await a.setBadge({ ...(a.badge as NonNullable<typeof a.badge>), on: false, token: null })
    expect(a.binding).toBeNull()
    await settle()
    expect(badgeState(bob.badges.get(a.ik), clock.now())).toBe('confirmed')
    expect(badgeState(bob.badges.get(a.ik), clock.now() + 7 * DAY + 2000)).toBe('expired')
    // No strikes for either side, and old peers' profile handling still works.
    for (const s of [...a.readySessions(bob.node.ik), ...bob.node.readySessions(a.ik)])
      expect(s.strikes).toBe(0)
  }, 60_000)

  test('only mutual contacts, contacts we asked and server co-members get the binding', async () => {
    const key = await newKey()
    const clock = new ManualClock()
    const hub = new Hub()
    const alice = await makeMember(hub, 'Alice', clock)
    const a = alice.node
    const token = await issue(key, a.ik, clock.now())
    await a.setBadge(own(token, a.ik, clock.now()))
    const listen = (m: { node: P2pNode }) => {
      const heard: [string, unknown][] = []
      m.node.onBinding((ik, t) => heard.push([ik, t]))
      return heard
    }
    const heardOf = (heard: [string, unknown][]) => heard.filter(([ik]) => ik === a.ik)

    // A requester Alice has not accepted: the hello and later profile frames carry none.
    const rita = await makeMember(hub, 'Rita', clock)
    const ritaHeard = listen(rita)
    expect((await rita.node.addContact(await a.myCard(), 'alice')).ok).toBe(true)
    await waitFor(() => a.contact(rita.node.ik)?.state === 'incoming', 'rita asks')
    await settle(100)
    await a.setBadge(own(await issue(key, a.ik, clock.now() + 1000), a.ik, clock.now()))
    await settle(100)
    expect(heardOf(ritaHeard)).toEqual([])

    // A mutual contact gets it when accepted (in the profile frame) and in later renewals.
    const bob = await makeMember(hub, 'Bob', clock)
    const bobHeard = listen(bob)
    expect((await bob.node.addContact(await a.myCard(), 'alice')).ok).toBe(true)
    await waitFor(() => a.contact(bob.node.ik)?.state === 'incoming', 'bob asks')
    // The one who asked hears it right away: Alice is the one asked, Bob the requester.
    await a.accept(bob.node.ik)
    await waitFor(() => heardOf(bobHeard).length > 0, 'bob hears')
    expect(heardOf(ritaHeard)).toEqual([])

    // Removed, a contact hears nothing more.
    await a.remove(bob.node.ik)
    bobHeard.length = 0
    await a.setBadge(own(await issue(key, a.ik, clock.now() + 2000), a.ik, clock.now()))
    await settle(100)
    expect(heardOf(bobHeard)).toEqual([])

    // A fellow member of a server of ours, not a contact, gets the profile frame.
    const room = await alice.servers.create('Members')
    const carol = await makeMember(hub, 'Carol', clock)
    const carolHeard = listen(carol)
    await joinWithCode(clock, alice, room, carol)
    expect(a.contact(carol.node.ik)).toBeUndefined()
    carolHeard.length = 0
    const renewed = await issue(key, a.ik, clock.now() + 3000)
    await a.setBadge(own(renewed, a.ik, clock.now()))
    await waitFor(() => heardOf(carolHeard).some(([, t]) => t === renewed), 'carol hears')
  }, 90_000)

  test('a binding for someone else, or past its time, is no badge', async () => {
    const key = await newKey()
    const clock = new ManualClock()
    const hub = new Hub()
    const alice = await withBadges(hub, 'Alice', clock, { keys: [key.jwk] })
    const bob = await withBadges(hub, 'Bob', clock, { keys: [key.jwk] })
    const carol = keyId(newKeyPair().pk)
    const a = alice.node
    // Alice hands out a real binding of another key (Carol's).
    await a.setBadge(own(await issue(key, carol, clock.now()), a.ik, clock.now()))
    await befriend(a, bob.node)
    await settle(100)
    expect(bob.badges.get(a.ik)).toBeUndefined()
    // Our own expired binding isn't handed out at all.
    await a.setBadge(
      own(await issue(key, a.ik, clock.now() - 8 * DAY), a.ik, clock.now() - 8 * DAY)
    )
    expect(a.binding).toBeNull()
  }, 60_000)

  test('a contact confirmed as an account another contact has gets the identity warning', async () => {
    const key = await newKey()
    const keys = { keys: [key.jwk] }
    const clock = new ManualClock()
    const hub = new Hub()
    const bob = await withBadges(hub, 'Bob', clock, keys)
    const old = await withBadges(hub, 'Alice', clock, keys)
    await old.node.setBadge(
      own(await issue(key, old.node.ik, clock.now()), old.node.ik, clock.now())
    )
    await befriend(old.node, bob.node)
    await waitFor(() => !!bob.badges.get(old.node.ik)?.ok, 'first confirmed')
    expect(bob.node.contact(old.node.ik)?.warning).toBeNull()
    // Someone else confirmed as another account: no warning.
    const carol = await withBadges(hub, 'Carol', clock, keys)
    await carol.node.setBadge(
      own(
        await issue(key, carol.node.ik, clock.now(), { sub: `carol@${HOST}` }),
        carol.node.ik,
        clock.now()
      )
    )
    await befriend(carol.node, bob.node)
    await waitFor(() => !!bob.badges.get(carol.node.ik)?.ok, 'carol confirmed')
    expect(bob.node.contact(carol.node.ik)?.warning).toBeNull()
    // A new key confirmed as alice's account (a reset without succession, or her account used
    // by someone else): its request carries the warning, naming the contact it may be.
    await jump(clock, 60_000)
    const fresh = await withBadges(hub, 'Alicia', clock, keys)
    await fresh.node.setBadge(
      own(
        await issue(key, fresh.node.ik, clock.now(), { sub: `ALICE@${HOST}` }),
        fresh.node.ik,
        clock.now()
      )
    )
    expect((await fresh.node.addContact(await bob.node.myCard(), 'new phone')).ok).toBe(true)
    await waitFor(() => bob.node.contact(fresh.node.ik)?.state === 'incoming', 'request')
    await waitFor(() => bob.node.contact(fresh.node.ik)?.warning === old.node.ik, 'warning')
    expect(bob.node.contact(old.node.ik)?.warning).toBeNull()
    // Verified, it stays clear on later checks.
    await bob.node.markVerified(fresh.node.ik)
    await bob.node.accept(fresh.node.ik)
    await jump(clock, DAY + BADGE.tickMs)
    await settle(100)
    expect(bob.node.contact(fresh.node.ik)?.warning).toBeNull()
  }, 60_000)
})

describe('badges in P2P servers', () => {
  test('member events carry the binding: a member who never met the owner sees it', async () => {
    const key = await newKey()
    const keys = { keys: [key.jwk] }
    const clock = new ManualClock()
    const hub = new Hub()
    const a = await makeMember(hub, 'Alice', clock)
    const token = await issue(key, a.node.ik, clock.now())
    await a.node.setBadge(own(token, a.node.ik, clock.now()))
    const room = await a.servers.create('Badges')
    const joins = (await a.store.db.getAllFromIndex('events', 'room_state', [room, 1])).filter(
      e => e.type === 'member' && e.skey === a.node.ik
    )
    expect(joins.map(e => (e.wire.c as { binding?: string }).binding)).toEqual([token])
    const b = await makeMember(hub, 'Bob', clock)
    await joinWithCode(clock, a, room, b)
    await a.node.setPaused(true)
    const c = await makeMember(hub, 'Carol', clock)
    const heard: [string, unknown][] = []
    c.node.onBinding((ik, t) => heard.push([ik, t]))
    const badges = new Badges({
      store: c.store,
      clock,
      verify: (t, ik) => verifyBinding(t, { ik, keys, host: HOST, now: new Date(clock.now()) }),
      contacts: () => [],
      warn: async () => {},
    })
    badgeSets.push(badges)
    c.node.onBinding((ik, t) => badges.offer(ik, t))
    await badges.start()
    await joinWithCode(clock, b, room, c)
    await pump(clock, () => heard.some(([ik]) => ik === a.node.ik), 'carol hears of the badge')
    expect(hub.online(a.node.peerId)).toBe(false)
    await waitFor(() => badgeState(badges.get(a.node.ik), clock.now()) === 'confirmed', 'checked')
    expect(badges.get(a.node.ik)?.ok?.sub).toBe(`alice@${HOST}`)
  }, 90_000)
})

describe('badges in P2P server member events', () => {
  test('turned on after joining, and renewed: posted again, not every day', async () => {
    const key = await newKey()
    const clock = new ManualClock()
    const hub = new Hub()
    const a = await makeMember(hub, 'Alice', clock)
    const room = await a.servers.create('Later')
    const posted = async () =>
      (await a.store.db.getAllFromIndex('events', 'room_state', [room, 1]))
        .filter(e => e.type === 'member' && e.skey === a.node.ik)
        .sort((x, y) => x.wire.ev.depth - y.wire.ev.depth)
        .map(e => (e.wire.c as { binding?: string }).binding ?? null)
    expect(await posted()).toEqual([null])
    // Nothing to post while the badge is off.
    await a.servers.refreshBadge()
    expect(await posted()).toEqual([null])
    const first = await issue(key, a.node.ik, clock.now())
    await a.node.setBadge(own(first, a.node.ik, clock.now()))
    const updated = a.node.profile.updated
    await a.servers.refreshBadge()
    expect(await posted()).toEqual([null, first])
    // The room rules take a new member event of ours only with a newer profile.
    expect(a.node.profile.updated).toBeGreaterThan(updated)
    // A day later: the one posted has most of its life left.
    await jump(clock, DAY)
    await a.node.setBadge(own(await issue(key, a.node.ik, clock.now()), a.node.ik, clock.now()))
    const kept = a.node.profile.updated
    await a.servers.refreshBadge()
    expect((await posted()).length).toBe(2)
    expect(a.node.profile.updated).toBe(kept)
    // Four days in: half its life is gone, the renewed one goes out.
    await jump(clock, 3 * DAY)
    const later = await issue(key, a.node.ik, clock.now())
    await a.node.setBadge(own(later, a.node.ik, clock.now()))
    await a.servers.refreshBadge()
    expect((await posted())[2]).toBe(later)
    // Turned off: nothing is posted (the last one stays until it expires).
    await a.node.setBadge({
      ...(a.node.badge as NonNullable<typeof a.node.badge>),
      on: false,
      token: null,
    })
    await jump(clock, 5 * DAY)
    await a.servers.refreshBadge()
    expect((await posted()).length).toBe(3)
  }, 60_000)
})

describe('BadgeKeeper', () => {
  const fakeNode = (ik = keyId(newKeyPair().pk)) => {
    const n = {
      ik,
      badge: null as ReturnType<typeof own> | null,
      async setBadge(b: ReturnType<typeof own> | null) {
        n.badge = b
      },
      bindingProof: (sub: string, ts: number) => `${sub}|${ts}`,
    }
    return n
  }

  test('turns on only with a binding, renews daily, after a reset at once, and off keeps the tail', async () => {
    const clock = new ManualClock()
    const node = fakeNode()
    const asked: [string, number, string][] = []
    let fail: Error | null = null
    const keeper = new BadgeKeeper({
      node: node as never,
      clock,
      sub: () => `alice@${HOST}`,
      request: async (ik, ts, proof): Promise<Issued> => {
        asked.push([ik, ts, proof])
        if (fail) throw fail
        return { token: `t${asked.length}`, sub: `alice@${HOST}`, expires_at: ts + BINDING_MAX_TTL }
      },
    })
    keeper.start()
    fail = new Error('ts must be within 5 minutes of the server clock')
    expect(
      await keeper.enable().then(
        () => 'ok',
        (e: Error) => e.message
      )
    ).toBe(fail.message)
    expect(node.badge).toBeNull()
    fail = null
    await keeper.enable()
    expect(node.badge?.on).toBe(true)
    expect(node.badge?.token).toBe('t2')
    const [, ts, proof] = asked[1]
    expect(ts).toBe(Math.floor(clock.now() / 1000))
    expect(proof).toBe(`alice@${HOST}|${ts}`)
    // Not due within the day.
    await jump(clock, BADGE.tickMs * 3)
    expect(asked.length).toBe(2)
    await jump(clock, DAY)
    await waitFor(() => node.badge?.token === 't3', 'renewed')
    // A failed renewal keeps the one we have and is tried again later.
    fail = new Error('offline')
    await jump(clock, DAY)
    await waitFor(() => asked.length === 4, 'tried')
    expect(node.badge?.token).toBe('t3')
    fail = null
    await jump(clock, BADGE.retryMs + BADGE.tickMs)
    await waitFor(() => node.badge?.token === 't5', 'retried')
    // A new identity key: the binding named the old one.
    node.ik = keyId(newKeyPair().pk)
    expect(keeper.due()).toBe(true)
    await keeper.refresh()
    expect(node.badge?.ik).toBe(node.ik)
    // Off: no token, but the expiry of the last one stays (peers may show it until then).
    const exp = node.badge?.exp
    await keeper.disable()
    expect(node.badge?.on).toBe(false)
    expect(node.badge?.token).toBeNull()
    expect(node.badge?.exp).toBe(exp as number)
    await jump(clock, 2 * DAY)
    expect(asked.length).toBe(6)
    keeper.stop()
  })

  test('a badge turned on for another account is turned off and never sent for this one', async () => {
    const clock = new ManualClock()
    const node = fakeNode()
    const asked: string[] = []
    let sub = `alice@${HOST}`
    const keeper = new BadgeKeeper({
      node: node as never,
      clock,
      sub: () => sub,
      request: async (_ik, ts): Promise<Issued> => {
        asked.push(sub)
        return { token: `t${asked.length}`, sub, expires_at: ts + BINDING_MAX_TTL }
      },
    })
    keeper.start()
    await keeper.enable()
    expect(node.badge?.on).toBe(true)
    // The identity moved into another account: off until the user opts in again.
    sub = `Bob@${HOST}`
    expect(keeper.due()).toBe(false)
    await jump(clock, BADGE.tickMs * 2)
    await waitFor(() => node.badge?.on === false, 'turned off')
    expect(node.badge?.token).toBeNull()
    await jump(clock, 3 * DAY)
    expect(asked).toEqual([`alice@${HOST}`])
    await keeper.refresh()
    expect(asked.length).toBe(1)
    // The same account in another letter case stays on.
    sub = `ALICE@${HOST.toUpperCase()}`
    await keeper.enable()
    sub = `alice@${HOST}`.toUpperCase()
    await jump(clock, BADGE.tickMs * 2)
    expect(node.badge?.on).toBe(true)
    keeper.stop()
  })

  test('the real node: proof by its identity key, carried once set, none after a move', async () => {
    const clock = new ManualClock()
    const hub = new Hub()
    const n = await makeNode(hub, 'Alice', { clock, host: HOST })
    nodes.push(n.node)
    const proof = n.node.bindingProof(`alice@${HOST}`, 1793056306) as string
    const self = await n.store.self()
    expect(proof).toBe(bindingProof(self?.ik as never, `alice@${HOST}`, 1793056306))
    expect(n.node.binding).toBeNull()
    await n.node.setBadge(own('tok', n.node.ik, clock.now()))
    expect(n.node.binding).toBe('tok')
    await n.node.setBadge(own('tok', keyId(newKeyPair().pk), clock.now()))
    expect(n.node.binding).toBeNull()
    await n.node.setBadge(own('tok', n.node.ik, clock.now()))
    await n.node.resetIdentity()
    expect(n.node.badge?.on).toBe(true)
    expect(n.node.badge?.token).toBeNull()
    expect(n.node.binding).toBeNull()
  })
})

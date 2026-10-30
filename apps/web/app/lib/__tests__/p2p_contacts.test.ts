import { describe, expect, test } from 'bun:test'
import {
  accept,
  addFromCard,
  applySuccession,
  block,
  blank,
  BLOCKED,
  dialable,
  ignore,
  INTRO_MAX,
  markVerified,
  overflowRequests,
  receiveRequest,
  recheckName,
  rename,
  requests,
  SELF_CARD,
  shieldOf,
  unfriended,
  updateDevices,
  visibleContacts,
  withProfile,
  type Contact,
} from '../p2p/contacts'
import { makeCard } from '../p2p/card'
import {
  keyId,
  newKeyPair,
  signCert,
  signProfile,
  signRevocation,
  signSuccession,
  type KeyPair,
} from '../p2p/keys'

const person = (name: string) => {
  const ik = newKeyPair()
  const dk = newKeyPair()
  const cert = signCert(ik, dk.pk, 1, 'test')
  return { ik, dk, cert, id: keyId(ik.pk), card: makeCard(ik, [cert], name, 'host'), name }
}

const hello = (p: ReturnType<typeof person>, intro = '') => ({
  ik: p.id,
  certs: [p.cert],
  profile: signProfile(p.ik, p.name, 5),
  intro,
})

const ME = keyId(newKeyPair().pk)

describe('contacts state machine', () => {
  test('add, request, accept', () => {
    const bob = person('Bob')
    const added = addFromCard([], bob.card, ME, 10)
    if (!added.ok) throw new Error(added.error)
    expect(added.contact.state).toBe('outgoing')
    expect(added.contact.name).toBe('Bob')
    expect(dialable(added.contact)).toHaveLength(1)
    // Bob adds us back: mutual.
    const r = receiveRequest([added.contact], hello(bob), 11)
    expect(r.kind).toBe('mutual')

    const carol = person('Carol')
    const req = receiveRequest([], hello(carol, 'hi, it is Carol'), 12)
    if (req.kind !== 'new') throw new Error(req.kind)
    expect(req.contact.state).toBe('incoming')
    expect(req.contact.intros).toEqual(['hi, it is Carol'])
    expect(dialable(req.contact)).toEqual([])
    expect(requests([req.contact])).toHaveLength(1)
    expect(visibleContacts([req.contact])).toHaveLength(0)
    const acc = accept(req.contact)
    expect(acc.state).toBe('mutual')
    expect(acc.intros).toEqual([])
    // Adding the card of someone who asked first also accepts.
    const viaCard = addFromCard([req.contact], carol.card, ME, 13)
    expect(viaCard.ok && viaCard.contact.state).toBe('mutual')
  })

  test('own card and blocked contacts are refused', () => {
    const me = person('Me')
    expect(addFromCard([], me.card, me.id, 1)).toEqual({ ok: false, error: SELF_CARD })
    const bob = person('Bob')
    const blocked = block({ ...blank(bob.id, 1), state: 'mutual' })
    expect(addFromCard([blocked], bob.card, ME, 2)).toEqual({ ok: false, error: BLOCKED })
    expect(receiveRequest([blocked], hello(bob), 3)).toEqual({ kind: 'dropped', why: 'blocked' })
  })

  test('request limits: intro length and at most 3 intros per identity', () => {
    const eve = person('Eve')
    const first = receiveRequest([], hello(eve, 'x'.repeat(900)), 1)
    if (first.kind !== 'new') throw new Error(first.kind)
    expect(first.contact.intros[0]).toHaveLength(INTRO_MAX)
    let list: Contact[] = [first.contact]
    for (const n of [2, 3]) {
      const r = receiveRequest(list, hello(eve, `again ${n}`), n)
      if (r.kind !== 'updated') throw new Error(r.kind)
      list = [r.contact]
    }
    expect(list[0].intros).toHaveLength(3)
    expect(receiveRequest(list, hello(eve, 'one more'), 9)).toEqual({
      kind: 'dropped',
      why: 'limit',
    })
    // The same intro again is not a new request.
    expect(receiveRequest(list, hello(eve, 'again 2'), 9).kind).toBe('updated')
    const ignored = ignore(list[0])
    expect(receiveRequest([ignored], hello(eve, 'hello?'), 10)).toEqual({
      kind: 'dropped',
      why: 'ignored',
    })
    expect(requests([ignored])).toHaveLength(0)
  })

  test('verified, petname, removal by the other side', () => {
    const bob = person('Bob')
    const c: Contact = { ...blank(bob.id, 1), state: 'mutual', name: 'Bob' }
    expect(shieldOf(c)).toBe('unverified')
    const v = markVerified(c, 5)
    expect(shieldOf(v)).toBe('verified')
    expect(rename(v, '  Bobby  ').petname).toBe('Bobby')
    expect(rename(v, '   ').petname).toBeNull()
    expect(unfriended(v).state).toBe('outgoing')
  })

  test('identity warnings for look-alike names', () => {
    const bob = person('Bob')
    const fake = person('bob')
    const existing: Contact = { ...blank(bob.id, 1), state: 'mutual', name: 'Bob' }
    const added = addFromCard([existing], fake.card, ME, 2)
    expect(added.ok && added.contact.warning).toBe(bob.id)
    expect(added.ok && shieldOf(added.contact)).toBe('warning')
    const req = receiveRequest([{ ...existing, name: 'Robert', petname: 'Bob' }], hello(fake), 3)
    expect(req.kind === 'new' && req.contact.warning).toBe(bob.id)
    // Verifying clears it.
    expect(added.ok && shieldOf(markVerified(added.contact, 4))).toBe('verified')
  })

  test('a name change is checked again, look-alike letters included', () => {
    const alice = person('Alice')
    const mallory = person('Mallory')
    const existing: Contact = { ...blank(alice.id, 1), state: 'mutual', name: 'Alice' }
    const m: Contact = { ...blank(mallory.id, 1), state: 'mutual', name: 'Mallory' }
    // Accepted without a warning, then a signed profile claims a Cyrillic "Аlice".
    const renamed = withProfile(m, signProfile(mallory.ik, '\u0410lice', 9))
    const checked = recheckName([existing, m], m, renamed)
    expect(checked.warning).toBe(alice.id)
    // The warning stays through later renames until the user verifies.
    const back = withProfile(checked, signProfile(mallory.ik, 'Mallory', 10))
    expect(recheckName([existing, checked], checked, back).warning).toBe(alice.id)
    expect(shieldOf(markVerified(back, 11))).toBe('verified')
    // Same name, nothing to check; accents and zero-width characters fold away.
    expect(recheckName([existing, m], m, { ...m, name: 'Mallory' }).warning).toBeNull()
    expect(recheckName([existing, m], m, { ...m, name: 'Ali\u200bc\u00e9' }).warning).toBe(alice.id)
  })

  test('a card renaming a known contact is checked for look-alikes too', () => {
    const alice = person('Alice')
    const mallory = person('\u0410lice')
    const existing: Contact = { ...blank(alice.id, 1), state: 'mutual', name: 'Alice' }
    const m: Contact = { ...blank(mallory.id, 1), state: 'outgoing', name: 'Mallory' }
    const added = addFromCard([existing, m], mallory.card, ME, 2)
    expect(added.ok && added.contact.name).toBe('\u0410lice')
    expect(added.ok && added.contact.warning).toBe(alice.id)
  })

  test('revoked devices are never merged back', () => {
    const bob = person('Bob')
    const rev = signRevocation(bob.ik, bob.cert.dk, 3)
    const c = updateDevices(
      { ...blank(bob.id, 1), state: 'mutual', certs: [bob.cert] },
      [],
      [rev],
      4
    )
    expect(c.certs).toEqual([])
    expect(updateDevices(c, [bob.cert], [], 5).certs).toEqual([])
    const again = receiveRequest([c], { ...hello(bob), certs: [bob.cert] }, 6)
    expect(again.kind !== 'dropped' && again.contact.certs).toEqual([])
    const viaCard = addFromCard([c], bob.card, ME, 7)
    expect(viaCard.ok && viaCard.contact.certs).toEqual([])
  })

  test('the request cap prunes the oldest unverified requests', () => {
    const reqs = [1, 2, 3, 4].map(n => ({
      ...blank(person(`P${n}`).id, n),
      state: 'incoming' as const,
      verified: n === 1,
    }))
    expect(overflowRequests(reqs, 2)).toEqual([reqs[1].ik])
    expect(overflowRequests(reqs, 1)).toEqual([reqs[1].ik, reqs[2].ik])
    expect(overflowRequests(reqs, 5)).toEqual([])
  })

  test('device move keeps verification, succession drops it', () => {
    const bob = person('Bob')
    const c = markVerified({ ...blank(bob.id, 1), state: 'mutual', certs: [bob.cert] }, 2)
    const dk2 = newKeyPair()
    const cert2 = signCert(bob.ik, dk2.pk, 3, 'new')
    const rev = signRevocation(bob.ik, bob.cert.dk, 3, cert2.dk)
    const moved = updateDevices(c, [cert2], [rev], 4)
    expect(moved.verified).toBe(true)
    expect(moved.notice).toEqual({ kind: 'moved', at: 4 })
    expect(dialable(moved).map(x => x.dk)).toEqual([cert2.dk])
    // Revocations signed by someone else are ignored.
    const forged = signRevocation(newKeyPair() as KeyPair, cert2.dk, 5)
    expect(dialable(updateDevices(moved, [], [forged], 5)).map(x => x.dk)).toEqual([cert2.dk])

    const next = newKeyPair()
    const nextDk = newKeyPair()
    const succ = signSuccession(bob.ik, next, 9)
    const after = applySuccession(
      [moved],
      succ,
      [signCert(next, nextDk.pk, 9, 'x')],
      signProfile(next, 'Bob', 9),
      10
    )
    expect(after?.ik).toBe(keyId(next.pk))
    expect(after?.verified).toBe(false)
    expect(after?.notice).toEqual({ kind: 'reset', at: 10 })
    expect(after?.state).toBe('mutual')
    // Unknown old identity: nothing to move.
    expect(applySuccession([], succ, [], null, 10)).toBeNull()
  })
})

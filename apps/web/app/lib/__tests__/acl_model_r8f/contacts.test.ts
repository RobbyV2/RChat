/* eslint-disable */
// @ts-nocheck
// Copy of notes/acl-model-r8f/contacts.test.ts (the executable reference model of the P2P ACL spec r8f), used only by tests.
import { setDefaultTimeout } from 'bun:test'
setDefaultTimeout(120_000)
// Revision 8 fix round 3 (ruling 10): the §1.7 contact, badge, succession and restore vectors (R8-*) run on contacts.ts,
// and a fuzz of message orders. Keys are names (contacts.ts): V is protected (rkV, epoch-0 primary p0, the creating
// device D1 with its v1 certificate); a thief steals D1 and holds p0, never ik or rkV; L is a legacy identity (hot ik).
import { describe, expect, test } from 'bun:test'
import { deflateRawSync } from 'node:zlib'
import {
  Contact,
  type CR,
  type Rec,
  type Msg,
  type Token,
  crD,
  recD,
  chainOf,
  restore,
  IdentityRecords,
  Backups,
  ownHalf,
  halfOf,
  CHAIN_MAX,
  shownName,
  serverSuccClaims,
} from './contacts'

const crV: CR = { ik: 'V', rk: 'rkV', pk: 'p0', byIk: true, byRk: true }
const r1: Rec = { ik: 'V', n: 1, prev: crD(crV), by: 'rkV', pk: 'pk1', keep: ['D2'] } // D1 stolen: dropped
const cert1D1: Msg = { k: 'cert1', ik: 'V', dk: 'D1', byIk: true }
const card = (extra: Msg[] = []): Msg[] => [{ k: 'cr', cr: crV }, cert1D1, ...extra]
const stripped = (): Msg[] => [cert1D1] // a card with `cr`, `head` and `certs2` removed (only the certs are signed)
const known = () => new Contact('V', 'card', card())

describe('contacts: the creation-record states (ruling 7; attack review C1)', () => {
  test("R8-cr-tofu: a known contact refuses another creation record for V's ik, with the warning; its devices are never trusted", () => {
    const c = known()
    c.recv({ k: 'cr', cr: { ...crV, rk: 'rkT' } }, 'hello')
    c.recv({ k: 'cert2', ik: 'V', dk: 'T1', n: 0, pk: 'p0', by: 'pT' }, 'hello')
    expect([c.st, c.cr, c.warning.startsWith('Someone may be impersonating'), c.trusted()]).toEqual(
      ['known', crV, true, ['D1']]
    )
  })
  test("R8-cr-stripped-card: a card without its creation record gives unknown (no proof), V's record then is a pending claim; Accept or a QR check pins it and the recovery applies", () => {
    for (const how of ['accept', 'qr'] as const) {
      const c = new Contact('V', 'card', stripped())
      expect([c.st, c.safetyHalf()]).toEqual(['unknown', 'scan'])
      c.recv({ k: 'cr', cr: crV }, 'hello')
      c.recv({ k: 'rec', rec: r1 }, 'hello')
      expect([c.st, c.warning, c.trusted(), c.safetyHalf()]).toEqual([
        'unknown',
        '',
        ['D1'],
        halfOf('V', 'rkV'),
      ])
      if (how === 'accept') expect(c.accept(crV)).toBe(true)
      else c.recv({ k: 'cr', cr: crV }, 'qr')
      expect([c.st, c.trusted(), c.safetyHalf() === ownHalf('V', crV)]).toEqual([
        'known',
        ['D2'],
        true,
      ])
    }
  })
  test("R8-cr-thief-request: a keyless hello from the stolen creating device after the recovery gives unknown; V's record then pins as above", () => {
    const c = new Contact('V', 'hello', [cert1D1]) // the thief's request, accepted by the user: no profile1 (ik erased)
    expect(c.st).toBe('unknown')
    c.recv({ k: 'cr', cr: crV }, 'qr')
    c.recv({ k: 'rec', rec: r1 }, 'hello')
    expect([c.st, c.trusted()]).toEqual(['known', ['D2']])
  })
  test("R8-cr-legacy-proof: a 0.3.0 hello's profile1 gives none; a thief's creation record made with L's ik, in a hello or a QR, is refused", () => {
    const c = new Contact('L', 'hello', [
      { k: 'profile1', ik: 'L', byIk: true },
      { k: 'cert1', ik: 'L', dk: 'L1', byIk: true },
    ])
    expect([c.st, c.safetyHalf()]).toEqual(['none', halfOf('L')])
    const crZ: CR = { ik: 'L', rk: 'rkZ', pk: 'pZ', byIk: true, byRk: true }
    c.recv({ k: 'cr', cr: crZ }, 'hello')
    c.recv({ k: 'cr', cr: crZ }, 'qr')
    expect([c.st, c.cr, c.trusted(), c.warning.startsWith("Someone has L's identity key")]).toEqual(
      ['none', undefined, ['L1'], true]
    )
  })
  test("R8-cr-proof-late: an unknown contact holding a thief's claim gets L's profile1: none, the claim refused, the warning", () => {
    const c = new Contact('L', 'carried', [{ k: 'cert1', ik: 'L', dk: 'L1', byIk: true }])
    c.recv({ k: 'cr', cr: { ik: 'L', rk: 'rkZ', pk: 'pZ', byIk: true, byRk: true } }, 'hello')
    expect([c.st, c.claims.length]).toEqual(['unknown', 1])
    c.recv({ k: 'profile1', ik: 'L', byIk: true }, 'hello')
    expect([c.st, c.claims.length, c.warning.startsWith("Someone has L's identity key")]).toEqual([
      'none',
      0,
      true,
    ])
    // a known record pinned for a legacy identity (the thief's, scanned in person) is void once proof arrives
    const k = new Contact('L', 'qr', [
      { k: 'cr', cr: { ik: 'L', rk: 'rkZ', pk: 'pZ', byIk: true, byRk: true } },
    ])
    k.recv({ k: 'profile1', ik: 'L', byIk: true }, 'hello')
    expect([k.st, k.cr]).toEqual(['none', undefined])
  })
  test("R8-cr-legacy-thief: a thief holding a 0.3.0 identity's ik sends a creation record and a recovery to an unknown contact; nothing applies, and the user's ik-signed records refuse the claim and still count", () => {
    const c = new Contact('L', 'carried', [{ k: 'cert1', ik: 'L', dk: 'L1', byIk: true }])
    const crZ: CR = { ik: 'L', rk: 'rkZ', pk: 'pZ', byIk: true, byRk: true }
    c.recv({ k: 'cr', cr: crZ }, 'hello')
    c.recv(
      { k: 'rec', rec: { ik: 'L', n: 1, prev: crD(crZ), by: 'rkZ', pk: 'pZ1', keep: ['Z1'] } },
      'hello'
    )
    expect([c.st, c.claims.length, c.trusted(), c.warning]).toEqual(['unknown', 1, ['L1'], ''])
    c.recv({ k: 'profile1', ik: 'L', byIk: true }, 'hello')
    c.recv({ k: 'cert1', ik: 'L', dk: 'L2', byIk: true }, 'hello')
    expect([c.st, c.claims.length, c.trusted()]).toEqual(['none', 0, ['L1', 'L2']])
  })
  test('R8-cr-late: a contact in state none (proof that ik is in use) refuses a creation record', () => {
    const c = new Contact('L', 'card', [
      { k: 'cert1', ik: 'L', dk: 'L1', byIk: true },
      { k: 'rev1', ik: 'L', dk: 'L0', byIk: true },
    ])
    expect(c.st).toBe('none')
    c.recv({ k: 'cr', cr: { ik: 'L', rk: 'rkL', pk: 'pL', byIk: true, byRk: true } }, 'card')
    expect([c.st, c.cr]).toEqual(['none', undefined])
  })
  test("R8-cr-after-update: a contact carried over from 0.3.0 (unknown) holds V's record as a pending claim; trust stays until Accept (N26 (c)); then the recovery applies", () => {
    const c = new Contact('V', 'carried', [cert1D1])
    c.recv({ k: 'cr', cr: crV }, 'card')
    c.recv({ k: 'rec', rec: r1 }, 'hello')
    expect([c.st, c.trusted(), c.warning]).toEqual(['unknown', ['D1'], ''])
    c.accept(crV)
    expect([c.st, c.trusted()]).toEqual(['known', ['D2']])
  })
  test("R8-cr-server-intro: a server introduction never pins: an unknown contact holds it as a claim; V's card later shows both and neither can be accepted until one is verified", () => {
    const c = new Contact('V', 'carried', [cert1D1])
    const other: CR = { ik: 'V', rk: 'rkT', pk: 'pT', byIk: true, byRk: true }
    c.recv({ k: 'cr', cr: other }, 'server')
    c.recv({ k: 'cr', cr: crV }, 'card')
    expect([
      c.st,
      c.claims.length,
      c.accept(crV),
      c.warning.startsWith('Someone may be impersonating'),
    ]).toEqual(['unknown', 2, false, true])
    c.recv({ k: 'cr', cr: crV }, 'safety')
    expect([c.st, c.cr]).toEqual(['known', crV])
  })
  test("R8-safety-rk: two creation records with one ik give different halves; an unprotected identity's half is 0.3.0's", () => {
    expect(halfOf('V', 'rkV')).not.toBe(halfOf('V', 'rkT'))
    expect(new Contact('L', 'hello', [{ k: 'profile1', ik: 'L', byIk: true }]).safetyHalf()).toBe(
      halfOf('L')
    )
  })
  test("R8-chain: a creation record without the recovery key's signature, or naming ik as its primary, is refused; a chain record with an unknown field is refused (attack review M4)", () => {
    const c = new Contact('V', 'card', [{ k: 'cr', cr: { ...crV, byRk: false } }, cert1D1])
    expect(c.st).toBe('unknown')
    expect(new Contact('V', 'card', [{ k: 'cr', cr: { ...crV, pk: 'V' } }]).st).toBe('unknown')
    const k = known()
    k.recv({ k: 'rec', rec: { ...r1, extra: { note: 1 } } }, 'hello')
    expect(k.trusted()).toEqual(['D1'])
    // a copy of the record with an extra field is no other record: its identity is the digest of its signed fields
    expect(crD({ ...crV, extra: { x: 1 } })).toBe(crD(crV))
  })
})

describe('contacts: the epoch rule over chains', () => {
  test("R8-epoch: after V's recovery the thief's epoch-0 revocation and certificate (by p0) are ignored", () => {
    const c = known()
    c.recv({ k: 'rec', rec: r1 }, 'hello')
    c.recv({ k: 'cert2', ik: 'V', dk: 'D3', n: 1, pk: 'pk1', by: 'pk1' }, 'hello')
    c.recv({ k: 'rev2', ik: 'V', dk: 'D2', n: 0, pk: 'p0', by: 'p0' }, 'hello')
    c.recv({ k: 'cert2', ik: 'V', dk: 'D4', n: 0, pk: 'p0', by: 'p0' }, 'hello')
    expect(c.trusted()).toEqual(['D2', 'D3'])
  })
  test("R8-epoch-before: the thief's epoch-0 revocation of D2 before the recovery; the recovery keeps D2", () => {
    const c = known()
    c.recv({ k: 'cert2', ik: 'V', dk: 'D2', n: 0, pk: 'p0', by: 'p0' }, 'hello')
    c.recv({ k: 'rev2', ik: 'V', dk: 'D2', n: 0, pk: 'p0', by: 'p0' }, 'hello')
    expect(c.trusted()).toEqual(['D1'])
    c.recv({ k: 'rec', rec: r1 }, 'hello')
    expect(c.trusted()).toEqual(['D2'])
  })
  test("R8-cert-v2: after a recovery a v2 certificate under the new primary is trusted; a v1 certificate received after it is ignored; the creating device's v1 certificate counts only while a head keeps it", () => {
    const c = known()
    c.recv({ k: 'rec', rec: { ...r1, keep: ['D1', 'D2'] } }, 'hello')
    c.recv({ k: 'cert2', ik: 'V', dk: 'D5', n: 1, pk: 'pk1', by: 'pk1' }, 'hello')
    c.recv({ k: 'cert1', ik: 'V', dk: 'D6', byIk: false }, 'hello') // nobody can sign a v1 certificate for V any more
    expect(c.trusted()).toEqual(['D1', 'D2', 'D5'])
    const c2 = known()
    c2.recv({ k: 'rec', rec: r1 }, 'hello')
    expect(c2.trusted().includes('D1')).toBe(false)
  })
  test("R8-profile: a protected identity's name comes from its v2 profile under the head's primary; one by an earlier epoch's primary is ignored; without one, and on an older peer, the card's name", () => {
    const c = known()
    c.cardName = 'Vee'
    c.recv({ k: 'rec', rec: r1 }, 'hello')
    c.recv({ k: 'profile2', ik: 'V', n: 0, pk: 'p0', by: 'p0', name: 'Thief', updated: 9 }, 'hello')
    expect(shownName(c)).toBe('Vee')
    c.recv(
      { k: 'profile2', ik: 'V', n: 1, pk: 'pk1', by: 'pk1', name: 'Victoria', updated: 5 },
      'hello'
    )
    expect(shownName(c)).toBe('Victoria')
    const old = new Contact('V', 'carried', [cert1D1])
    old.cardName = 'Vee'
    old.recv(
      { k: 'profile2', ik: 'V', n: 1, pk: 'pk1', by: 'pk1', name: 'Victoria', updated: 5 },
      'hello'
    )
    expect(shownName(old)).toBe('Vee')
  })
  test('R8-rk-revoke: a revocation signed by the recovery key applies after a recovery; after a reset one signed by the old key is ignored (key death)', () => {
    const c = known()
    const rx: Rec = { ...r1, keep: ['D2', 'D5'] }
    c.recv({ k: 'rec', rec: rx }, 'hello')
    c.recv({ k: 'rev2', ik: 'V', dk: 'D5', n: 0, pk: 'p0', by: 'rkV' }, 'hello')
    expect(c.trusted()).toEqual(['D2'])
    const c2 = known()
    const reset: Rec = {
      ik: 'V',
      n: 1,
      prev: crD(crV),
      by: 'rkV',
      rk: 'rkV2',
      pk: 'pk1',
      keep: ['D2', 'D5'],
    }
    c2.recv({ k: 'rec', rec: reset }, 'hello')
    c2.recv({ k: 'rev2', ik: 'V', dk: 'D5', n: 0, pk: 'p0', by: 'rkV' }, 'hello')
    expect(c2.trusted()).toEqual(['D2', 'D5'])
  })
  test("R8-cr-after-recovery: a second creation record after V's recovery is refused; the recovery stays", () => {
    const c = known()
    c.recv({ k: 'rec', rec: r1 }, 'hello')
    c.recv({ k: 'cr', cr: { ...crV, rk: 'rkT' } }, 'hello')
    expect([c.trusted(), c.chain()!.top]).toEqual([['D2'], 1])
  })
  test("R8-restore-contact: V restores (keep {N}); the thief's epoch-0 records are ignored", () => {
    const c = known()
    c.recv(
      { k: 'rec', rec: { ik: 'V', n: 1, prev: crD(crV), by: 'rkV', pk: 'pkN', keep: ['N'] } },
      'hello'
    )
    c.recv({ k: 'rev2', ik: 'V', dk: 'N', n: 0, pk: 'p0', by: 'p0' }, 'hello')
    c.recv({ k: 'cert1', ik: 'V', dk: 'T9', byIk: false }, 'hello')
    expect(c.trusted()).toEqual(['N'])
  })
  test('R8-same-n: two recoveries with the same n both count until a record cites one', () => {
    const c = known()
    const ra: Rec = { ik: 'V', n: 1, prev: crD(crV), by: 'rkV', pk: 'pkA', keep: ['A'] },
      rb: Rec = { ik: 'V', n: 1, prev: crD(crV), by: 'rkV', pk: 'pkB', keep: ['B'] }
    c.recv({ k: 'rec', rec: rb }, 'hello')
    c.recv({ k: 'rec', rec: ra }, 'hello')
    expect(c.trusted()).toEqual(['A', 'B'])
    c.recv(
      { k: 'rec', rec: { ik: 'V', n: 2, prev: recD(ra), by: 'rkV', pk: 'pk2', keep: ['A', 'B'] } },
      'hello'
    )
    expect([c.chain()!.top, c.trusted()]).toEqual([2, ['A', 'B']])
  })
  test("R8-rival-reset: the user's reset and a thief's reset, both by the old key: no device trusted, the warning", () => {
    const c = known()
    c.recv(
      {
        k: 'rec',
        rec: { ik: 'V', n: 1, prev: crD(crV), by: 'rkV', rk: 'rkV2', pk: 'pk1', keep: ['D2'] },
      },
      'hello'
    )
    c.recv(
      {
        k: 'rec',
        rec: { ik: 'V', n: 1, prev: crD(crV), by: 'rkV', rk: 'rkZ', pk: 'pZ', keep: ['Z1'] },
      },
      'hello'
    )
    expect([c.trusted(), c.warning.startsWith("Someone has V's backup phrase")]).toEqual([[], true])
  })
})

describe('contacts: succession claims (ruling 6; attack review I4)', () => {
  const crW: CR = { ik: 'W', rk: 'rkW', pk: 'pW', byIk: true, byRk: true }
  test('R8-succession: two v1 claims of a legacy identity are both held; nothing applies automatically; Accept is a merge, Verify adds the mark', () => {
    const c = new Contact('L', 'hello', [
      { k: 'profile1', ik: 'L', byIk: true },
      { k: 'cert1', ik: 'L', dk: 'L1', byIk: true },
    ])
    c.recv(
      { k: 'succ1', old: 'L', new: crW, newCr: crD(crW), byOldIk: true, byNewRk: true },
      'hello'
    )
    c.recv(
      {
        k: 'succ1',
        old: 'L',
        new: { ...crW, ik: 'W2', rk: 'rkW2' },
        newCr: crD({ ...crW, ik: 'W2', rk: 'rkW2' }),
        byOldIk: true,
        byNewRk: true,
      },
      'hello'
    )
    expect([c.succ.length, c.trusted()]).toEqual([2, ['L1']])
    expect(c.acceptSucc('W', false)).toMatchObject({ accepted: true })
    expect(c.succ.find(x => x.new === 'W2')?.accepted).toBeUndefined()
    expect(c.acceptSucc('W', true)).toMatchObject({ verified: true })
    // a v1 claim whose new side is signed by the new ik (not its recovery key) is refused: a protected ik signs nothing
    c.recv(
      {
        k: 'succ1',
        old: 'L',
        new: { ...crW, ik: 'W3' },
        newCr: crD({ ...crW, ik: 'W3' }),
        byOldIk: true,
        byNewRk: false,
      },
      'hello'
    )
    expect(c.succ.some(x => x.new === 'W3')).toBe(false)
  })
  test('R8-succession-accept: Accept one of two claims merges it (unverified) and leaves the other a claim; Verify adds the mark', () => {
    const c = new Contact('L', 'hello', [{ k: 'profile1', ik: 'L', byIk: true }])
    c.recv(
      { k: 'succ1', old: 'L', new: crW, newCr: crD(crW), byOldIk: true, byNewRk: true },
      'hello'
    )
    c.recv(
      {
        k: 'succ1',
        old: 'L',
        new: { ...crW, ik: 'W2', rk: 'rkW2' },
        newCr: crD({ ...crW, ik: 'W2', rk: 'rkW2' }),
        byOldIk: true,
        byNewRk: true,
      },
      'hello'
    )
    const a = c.acceptSucc('W', false)
    expect([a?.accepted, a?.verified, c.succ.find(x => x.new === 'W2')?.accepted]).toEqual([
      true,
      undefined,
      undefined,
    ])
    expect(c.acceptSucc('W', true)?.verified).toBe(true)
  })
  test("R8-succession-server: members show every distinct verified succ value of a member's profile writes, the later thief's claim included", () => {
    expect(
      serverSuccClaims([
        { succ: { new: 'W', verified: true } },
        { succ: { new: 'T', verified: true } },
        { succ: { new: 'X', verified: false } },
        {},
      ])
    ).toEqual(['T', 'W'])
  })
  test("R8-succession-protected: a v2 claim verifies against the chain and the recovery key in force; a device thief can't sign one; after a reset the old phrase's claim is ignored; after rival resets both show", () => {
    const c = known()
    c.recv({ k: 'rec', rec: r1 }, 'hello')
    const h1 = recD(r1)
    c.recv(
      {
        k: 'succ2',
        old: 'V',
        head: h1,
        by: 'rkV',
        chain: [],
        new: crW,
        newCr: crD(crW),
        byNewRk: true,
      },
      'hello'
    )
    c.recv(
      {
        k: 'succ2',
        old: 'V',
        head: h1,
        by: 'pk1',
        chain: [],
        new: { ...crW, ik: 'W9' },
        newCr: crD({ ...crW, ik: 'W9' }),
        byNewRk: true,
      },
      'hello'
    ) // the primary
    c.recv(
      {
        k: 'succ2',
        old: 'V',
        head: crD(crV),
        by: 'p0',
        chain: [],
        new: { ...crW, ik: 'W8' },
        newCr: crD({ ...crW, ik: 'W8' }),
        byNewRk: true,
      },
      'hello'
    ) // the thief
    expect(c.succ.map(x => x.new)).toEqual(['W'])
    // the chain can travel with the claim
    const c3 = known()
    c3.recv(
      {
        k: 'succ2',
        old: 'V',
        head: h1,
        by: 'rkV',
        chain: [r1],
        new: crW,
        newCr: crD(crW),
        byNewRk: true,
      },
      'hello'
    )
    expect(c3.succ.length).toBe(1)
    // after a reset, the leaked old phrase is dead: its claim is ignored
    const c2 = known()
    const reset: Rec = {
      ik: 'V',
      n: 1,
      prev: crD(crV),
      by: 'rkV',
      rk: 'rkV2',
      pk: 'pk1',
      keep: ['D2'],
    }
    c2.recv({ k: 'rec', rec: reset }, 'hello')
    c2.recv(
      {
        k: 'succ2',
        old: 'V',
        head: crD(crV),
        by: 'rkV',
        chain: [],
        new: { ...crW, ik: 'W7' },
        newCr: crD({ ...crW, ik: 'W7' }),
        byNewRk: true,
      },
      'hello'
    )
    c2.recv(
      {
        k: 'succ2',
        old: 'V',
        head: recD(reset),
        by: 'rkV2',
        chain: [],
        new: crW,
        newCr: crD(crW),
        byNewRk: true,
      },
      'hello'
    )
    expect(c2.succ.map(x => x.new)).toEqual(['W'])
    // rival resets: each branch's key in force may sign; both show for the user to verify
    const c4 = known()
    const rz: Rec = { ik: 'V', n: 1, prev: crD(crV), by: 'rkV', rk: 'rkZ', pk: 'pZ', keep: ['Z1'] }
    c4.recv({ k: 'rec', rec: reset }, 'hello')
    c4.recv({ k: 'rec', rec: rz }, 'hello')
    c4.recv(
      {
        k: 'succ2',
        old: 'V',
        head: recD(reset),
        by: 'rkV2',
        chain: [],
        new: crW,
        newCr: crD(crW),
        byNewRk: true,
      },
      'hello'
    )
    c4.recv(
      {
        k: 'succ2',
        old: 'V',
        head: recD(rz),
        by: 'rkZ',
        chain: [],
        new: { ...crW, ik: 'WZ' },
        newCr: crD({ ...crW, ik: 'WZ' }),
        byNewRk: true,
      },
      'hello'
    )
    expect(c4.succ.map(x => x.new).sort()).toEqual(['W', 'WZ'])
  })
  test("R8-succession-cap: at the chain's cap a ninth record is refused, and the move needs no chain slot", () => {
    let prev = crD(crV)
    const recs: Rec[] = []
    for (let n = 1; n <= CHAIN_MAX + 1; n++) {
      const r: Rec = { ik: 'V', n, prev, by: 'rkV', pk: `pk${n}`, keep: ['D2'] }
      recs.push(r)
      prev = recD(r)
    }
    const C = chainOf(crV, recs)
    expect(C.top).toBe(CHAIN_MAX)
    expect(
      restore(
        'rkV',
        ['V'],
        [{ k: 'cr', cr: crV }, ...recs.slice(0, CHAIN_MAX).map(r => ({ k: 'rec', rec: r }) as Msg)],
        'N',
        'pkN'
      )
    ).toEqual({ ok: false, why: 'at-cap' })
    const c = known()
    for (const r of recs.slice(0, CHAIN_MAX)) c.recv({ k: 'rec', rec: r }, 'hello')
    c.recv(
      {
        k: 'succ2',
        old: 'V',
        head: recD(recs[CHAIN_MAX - 1]),
        by: 'rkV',
        chain: [],
        new: crW,
        newCr: crD(crW),
        byNewRk: true,
      },
      'hello'
    )
    expect(c.succ.length).toBe(1)
  })
  test("R8-succession-overflow: a thief holding a legacy ik fills the claims first; the genuine one is told 'Many moves claimed'; a scanned card of the new identity attaches it", () => {
    const c = new Contact('L', 'hello', [{ k: 'profile1', ik: 'L', byIk: true }])
    for (let i = 0; i < 6; i++) {
      const nw = { ...crW, ik: `J${i}`, rk: `rkJ${i}` }
      c.recv(
        { k: 'succ1', old: 'L', new: nw, newCr: crD(nw), byOldIk: true, byNewRk: true },
        'hello'
      )
    }
    c.recv(
      { k: 'succ1', old: 'L', new: crW, newCr: crD(crW), byOldIk: true, byNewRk: true },
      'hello'
    )
    expect([c.succ.length, c.succOverflow, c.succ.some(x => x.new === 'W')]).toEqual([
      4,
      true,
      false,
    ])
    c.recv(
      { k: 'succ1', old: 'L', new: crW, newCr: crD(crW), byOldIk: true, byNewRk: true },
      'card'
    )
    expect([c.succ.some(x => x.new === 'W'), c.succ.slice(0, 4).map(x => x.new)]).toEqual([
      true,
      ['J0', 'J1', 'J2', 'J3'],
    ])
  })
})

describe('contacts: badges against heads (completeness review I3)', () => {
  const tokU: Token = { sub: 'v@inst', ik: 'V', head: { n: 1, d: recD(r1) }, iat: 10 }
  const tokT: Token = { sub: 'mallory@inst', ik: 'V', head: { n: 0, d: crD(crV) }, iat: 20 } // the thief, by p0, after
  test('R8-badge-stale: a contact holding record 1 ignores a token for an older head; one that took it before learning record 1 drops it then; a token with no head is ignored', () => {
    const c = known()
    c.recv({ k: 'rec', rec: r1 }, 'hello')
    c.recv({ k: 'badge', tok: tokT }, 'hello')
    c.recv({ k: 'badge', tok: { sub: 'mallory@inst', ik: 'V', iat: 30 } }, 'hello')
    c.recv({ k: 'badge', tok: tokU }, 'hello')
    expect(c.badge?.sub).toBe('v@inst')
    const c2 = known()
    c2.recv({ k: 'badge', tok: tokT }, 'hello')
    expect(c2.badge?.sub).toBe('mallory@inst')
    c2.recv({ k: 'rec', rec: r1 }, 'hello')
    expect(c2.badge).toBeUndefined()
    c2.recv({ k: 'badge', tok: tokU }, 'hello')
    expect(c2.badge?.sub).toBe('v@inst')
    // a token naming a head the contact doesn't hold yet waits for the chain
    const c3 = known()
    c3.recv({ k: 'badge', tok: tokU }, 'hello')
    expect([c3.badge, c3.badgeTodo.length]).toEqual([undefined, 1])
    c3.recv({ k: 'rec', rec: r1 }, 'hello')
    expect(c3.badge?.sub).toBe('v@inst')
  })
  test("R8-badge: a legacy contact keeps 0.3.0's badge rule (no head)", () => {
    const c = new Contact('L', 'hello', [{ k: 'profile1', ik: 'L', byIk: true }])
    c.recv({ k: 'badge', tok: { sub: 'l@inst', ik: 'L', iat: 1 } }, 'hello')
    expect(c.badge?.sub).toBe('l@inst')
  })
})

describe("contacts: restore and the account's records (ruling 9; attack review C5)", () => {
  test("R8-restore-noaccount: the identity id from a contact's code, the creation record and chain fetched from peers (one peer stale, one a thief's minted record for a legacy-looking id)", () => {
    const fetched: Msg[] = [
      { k: 'cr', cr: crV },
      { k: 'rec', rec: r1 },
      { k: 'cr', cr: { ik: 'V', rk: 'rkZ', pk: 'pZ', byIk: false, byRk: true } },
    ]
    const out = restore('rkV', ['V'], fetched, 'N', 'pkN')
    expect(out).toMatchObject({
      ok: true,
      ik: 'V',
      head: recD(r1),
      rec: { n: 2, prev: recD(r1), by: 'rkV', keep: ['N'] },
    })
    // a truncated chain (a peer holding only the creation record after a reset): keep fetching
    const reset: Rec = {
      ik: 'V',
      n: 1,
      prev: crD(crV),
      by: 'rkV',
      rk: 'rkV2',
      pk: 'pk1',
      keep: ['D2'],
    }
    expect(restore('rkV2', ['V'], [{ k: 'cr', cr: crV }], 'N', 'pkN')).toEqual({
      ok: false,
      why: 'keep-fetching',
    })
    expect(
      restore(
        'rkV2',
        ['V'],
        [
          { k: 'cr', cr: crV },
          { k: 'rec', rec: reset },
        ],
        'N',
        'pkN'
      )
    ).toMatchObject({ ok: true, head: recD(reset) })
    // no id from any source: the app makes a new identity and says the old one can't be found (R8-restore-nobackup)
    expect(restore('rkV', [], fetched, 'N', 'pkN')).toEqual({ ok: false, why: 'no-id' })
    expect(restore('rkV', ['V'], [], 'N', 'pkN')).toEqual({ ok: false, why: 'no-record' })
  })
  test("R8-identity-record-delete: deleting or truncating the account's identity record needs re-auth; extending it doesn't", () => {
    const s = new IdentityRecords()
    expect(s.put('V', crV, [])).toBe('ok')
    expect(s.put('V', crV, [r1])).toBe('ok')
    expect(s.put('V', crV, [])).toBe('reauth') // a stolen session can't truncate it
    expect(s.put('V', { ...crV, rk: 'rkT' }, [])).toBe('reauth')
    expect(s.delete('V')).toBe('reauth')
    expect(s.put('V', crV, [{ ...r1, by: 'rkT' }])).toBe('invalid')
    expect(s.delete('V', true)).toBe('ok')
  })
  test("R8-backup-overwrite: an emptied dump sealed on the stolen device doesn't erase the earlier versions; purging them needs re-auth", () => {
    const b = new Backups()
    b.put('V', 'full', 1)
    b.put('V', 'full2', 2)
    b.put('V', 'empty', 3)
    expect(b.list('V').map(x => x.blob)).toEqual(['full', 'full2', 'empty'])
    expect([b.purge('V'), b.off('V'), b.list('V').length]).toEqual(['reauth', 'reauth', 3])
  })
})

describe("contacts: fix round 4 (the controller's rulings 3 and 4 on the r8d reviews; completeness review I2, I3, M1; attack review M3, M6)", () => {
  const crW: CR = { ik: 'W', rk: 'rkW', pk: 'pW', byIk: true, byRk: true }
  const DAY = 86_400_000
  const blobs = (b: Backups, now?: number) => b.list('V', now).map(x => x.blob)
  // I2 (a), ruling 3: R8-backup-overwrite extended (the verifier's vectors) and the size limits
  test("R8-backup-overwrite (fix round 4): a stolen device's emptied dumps, any number, never remove a day's first version; only time removes them", () => {
    const b = new Backups()
    b.put('V', 'full-d0', 0)
    b.put('V', 'full-d1', DAY + 5)
    b.put('V', 'full-d2', 2 * DAY)
    for (let i = 0; i < 50; i++)
      expect(b.put('V', `empty${i}`, 2 * DAY + 1000 + i * 1000)).toBe('ok')
    expect(blobs(b).filter(x => x.startsWith('full'))).toEqual(['full-d0', 'full-d1', 'full-d2'])
    const at = (d: number) => blobs(b, d * DAY).filter(x => x.startsWith('full'))
    expect([at(29), at(32), at(33), b.list('V').length]).toEqual([
      ['full-d0', 'full-d1', 'full-d2'],
      ['full-d1', 'full-d2'],
      [],
      3,
    ])
  })
  test('R8-backup-overwrite (fix round 4): a backup older than 30 days survives three emptied dumps; hourly honest uploads for 60 days keep at most 35 versions with no re-auth', () => {
    const b = new Backups()
    b.put('V', 'full-a', 0)
    b.put('V', 'full-b', DAY)
    for (let i = 0; i < 3; i++) b.put('V', `empty${i}`, 40 * DAY + i)
    expect(blobs(b)).toEqual(['full-b', 'empty0', 'empty1', 'empty2'])
    const h = new Backups()
    for (let i = 0; i < 60 * 24; i++) expect(h.put('V', `g${i}`, i * 3_600_000)).toBe('ok')
    expect([
      h.list('V').length <= 35,
      h.list('V').at(-1)!.blob,
      h.purge('V'),
      h.off('V'),
      h.purge('V', true),
      h.list('V').length,
    ]).toEqual([true, 'g1439', 'reauth', 'reauth', 'ok', 0])
  })
  test("R8-backup-size: a version over P2P_BACKUP_MAX_MIB, or an account total over P2P_BACKUP_TOTAL_MIB, is refused ('full') and evicts nothing; 0 means no total; a stale version number is a conflict", () => {
    const MiB = 1 << 20
    const b = new Backups(64 * MiB, 256 * MiB)
    expect(b.put('V', 'big', 0, 65 * MiB)).toBe('full')
    expect(b.put('V', 'a', 0, 60 * MiB)).toBe('ok')
    expect(b.put('W', 'b', 1, 60 * MiB)).toBe('ok') // a second identity of the same account
    expect(b.put('V', 'c', DAY, 60 * MiB)).toBe('ok')
    expect(b.put('V', 'd', 2 * DAY, 60 * MiB)).toBe('ok') // 240 MiB
    expect(b.put('V', 'e', 3 * DAY, 60 * MiB)).toBe('full') // 300 MiB: refused, nothing evicted
    expect([blobs(b), b.list('W').map(x => x.blob)]).toEqual([['a', 'c', 'd'], ['b']])
    const u = new Backups(64 * MiB, 0)
    for (let i = 0; i < 10; i++) expect(u.put('V', `v${i}`, i * DAY, 60 * MiB)).toBe('ok')
    expect(u.put('V', 'x', 11 * DAY, 1, 3)).toBe('conflict')
  })
  // I2 (b): creation-record claims are capped like succession claims
  test("R8-cr-claims-overflow: a hot-ik holder's made-up records stop at the cap, the first kept, never FIFO; a card the user opens still attaches", () => {
    const c = new Contact('L', 'carried', [{ k: 'cert1', ik: 'L', dk: 'L1', byIk: true }])
    const mk = (i: number): CR => ({ ik: 'L', rk: `rkZ${i}`, pk: `pZ${i}`, byIk: true, byRk: true })
    for (let i = 0; i < 10; i++) c.recv({ k: 'cr', cr: mk(i) }, 'hello')
    expect([c.claims.length, c.claims[0].cr.rk, c.crOverflow]).toEqual([4, 'rkZ0', true])
    c.recv({ k: 'cr', cr: { ik: 'L', rk: 'rkL', pk: 'pL', byIk: true, byRk: true } }, 'card')
    expect(c.claims.length).toBe(5)
  })
  // I2 (c): a contact made from a server source holds its record as a claim
  test("R8-cr-server-intro (fix round 4): a contact created from a server source holds the record as a pending claim, never pinned; V's card makes two claims; a QR pins V's", () => {
    const other: CR = { ik: 'V', rk: 'rkT', pk: 'pT', byIk: true, byRk: true }
    const c = new Contact('V', 'server', [{ k: 'cr', cr: other }])
    expect([c.st, c.claims.length, c.cr]).toEqual(['unknown', 1, undefined])
    c.recv({ k: 'cr', cr: crV }, 'card')
    expect([c.st, c.claims.length]).toEqual(['unknown', 2])
    c.recv({ k: 'cr', cr: crV }, 'qr')
    expect([c.st, c.cr]).toEqual(['known', crV])
  })
  // I2 (d): restore tries every id; a frozen identity is offered the move
  test("R8-restore-noaccount (fix round 4): every id is tried, a wrong first id doesn't hide V; after rival resets restore ends in frozen at the phrase's branch, never keep-fetching", () => {
    const fetched: Msg[] = [
      { k: 'cr', cr: crV },
      { k: 'rec', rec: r1 },
    ]
    expect(restore('rkV', ['Wold', 'V'], fetched, 'N', 'pkN')).toMatchObject({
      ok: true,
      ik: 'V',
      head: recD(r1),
    })
    const reset: Rec = {
      ik: 'V',
      n: 1,
      prev: crD(crV),
      by: 'rkV',
      rk: 'rkV2',
      pk: 'pkU',
      keep: ['D2'],
    }
    const rival: Rec = {
      ik: 'V',
      n: 1,
      prev: crD(crV),
      by: 'rkV',
      rk: 'rkZ',
      pk: 'pkZ',
      keep: ['Z1'],
    }
    expect(
      restore(
        'rkV2',
        ['V'],
        [
          { k: 'cr', cr: crV },
          { k: 'rec', rec: reset },
          { k: 'rec', rec: rival },
        ],
        'N',
        'pkN'
      )
    ).toEqual({ ok: false, why: 'frozen', ik: 'V', head: recD(reset) })
  })
  // I3: succession formats, transport and held claims (the verifier's vectors, with new_cr)
  const v2 = (
    o: Partial<{ head: string; by: string; chain: Rec[]; new: CR }> = {}
  ): Extract<Msg, { k: 'succ2' }> => {
    const m = {
      k: 'succ2' as const,
      old: 'V',
      head: recD(r1),
      by: 'rkV',
      chain: [] as Rec[],
      new: crW,
      byNewRk: true,
      ...o,
    }
    return { ...m, newCr: crD(m.new) }
  }
  test("R8-succession-unknown: a carried contact holds V's v2 with the creation-record claim; Accept applies both; a thief's held v2 never applies once V's record is pinned by QR; held v2s are refused on proof", () => {
    const c = new Contact('V', 'carried', [cert1D1])
    c.recv({ k: 'cr', cr: crV }, 'hello')
    c.recv({ k: 'rec', rec: r1 }, 'hello')
    c.recv(v2(), 'hello')
    expect([c.st, c.succ.length, c.trusted()]).toEqual(['unknown', 0, ['D1']])
    expect(c.accept(crV)).toBe(true)
    expect([c.st, c.succ.map(x => x.new), c.trusted()]).toEqual(['known', ['W'], ['D2']])
    const crT: CR = { ik: 'V', rk: 'rkT', pk: 'pT', byIk: true, byRk: true }
    const rT: Rec = { ik: 'V', n: 1, prev: crD(crT), by: 'rkT', pk: 'pT1', keep: ['T1'] }
    const t = new Contact('V', 'carried', [cert1D1])
    t.recv({ k: 'cr', cr: crT }, 'hello')
    t.recv(
      v2({ head: recD(rT), by: 'rkT', chain: [rT], new: { ...crW, ik: 'WT', rk: 'rkWT' } }),
      'hello'
    )
    t.recv({ k: 'cr', cr: crV }, 'qr')
    expect([t.st, t.cr?.rk, t.succ.length]).toEqual(['known', 'rkV', 0])
    const l = new Contact('L', 'carried', [{ k: 'cert1', ik: 'L', dk: 'L1', byIk: true }])
    const crTL: CR = { ik: 'L', rk: 'rkT', pk: 'pT', byIk: true, byRk: true }
    l.recv({ k: 'cr', cr: crTL }, 'hello')
    l.recv({ ...v2({ head: crD(crTL), by: 'rkT' }), old: 'L' }, 'hello')
    l.recv({ k: 'profile1', ik: 'L', byIk: true }, 'hello')
    expect([l.st, l.succ.length, l.succTodo.length]).toEqual(['none', 0, 0])
  })
  test("R8-succession-chain-late: a card's v2 (no old chain) before the chain is held, and counts when the old identity's hello brings it; refused if the arriving chain kills its key", () => {
    const c = new Contact('V', 'card', card())
    c.recv(v2(), 'card')
    expect(c.succ.length).toBe(0)
    c.recv({ k: 'rec', rec: r1 }, 'hello')
    expect(c.succ.map(x => x.new)).toEqual(['W'])
    const reset: Rec = {
      ik: 'V',
      n: 2,
      prev: recD(r1),
      by: 'rkV',
      rk: 'rkV2',
      pk: 'pk2',
      keep: ['D2'],
    }
    const rOld: Rec = { ik: 'V', n: 2, prev: recD(r1), by: 'rkV', pk: 'pX', keep: ['X1'] }
    const d = new Contact('V', 'card', card())
    d.recv(v2({ head: recD(rOld) }), 'card')
    d.recv({ k: 'rec', rec: r1 }, 'hello')
    d.recv({ k: 'rec', rec: reset }, 'hello')
    d.recv({ k: 'rec', rec: rOld }, 'hello')
    expect(d.succ.length).toBe(0)
  })
  test("R8-succession-030: a 0.3.0 v1 (no new_cr, sig_new by the new ik) is a legacy claim with Verify and Accept, never applied, and proof that the old ik is in use; a v1 with new_cr whose sig_new verifies only under ik' stays refused; a new_cr that doesn't match the record is refused", () => {
    const c = new Contact('L', 'carried', [{ k: 'cert1', ik: 'L', dk: 'L1', byIk: true }])
    c.recv(
      {
        k: 'succ1',
        old: 'L',
        new: { ik: 'L2', rk: '', pk: '', byIk: true, byRk: false },
        byOldIk: true,
        byNewRk: false,
        byNewIk: true,
      },
      'hello'
    )
    c.recv(
      {
        k: 'succ1',
        old: 'L',
        new: { ...crW, ik: 'W3' },
        newCr: crD({ ...crW, ik: 'W3' }),
        byOldIk: true,
        byNewRk: false,
        byNewIk: true,
      },
      'hello'
    )
    c.recv(
      {
        k: 'succ1',
        old: 'L',
        new: crW,
        newCr: crD({ ...crW, ik: 'W4' }),
        byOldIk: true,
        byNewRk: true,
      },
      'hello'
    )
    expect([
      c.st,
      c.succ.map(x => [x.new, x.legacy ?? false, x.accepted ?? false]),
      c.trusted(),
    ]).toEqual(['none', [['L2', true, false]], ['L1']])
  })
  test('R8-succession-held-cap: held v2 claims are bounded, never FIFO; a direct source attaches; a v2 at none is refused with no new warning', () => {
    const c = new Contact('V', 'carried', [cert1D1])
    c.recv({ k: 'cr', cr: crV }, 'hello')
    for (let i = 0; i < 6; i++) c.recv(v2({ new: { ...crW, ik: `J${i}`, rk: `rkJ${i}` } }), 'hello')
    c.recv(v2(), 'card')
    expect([c.succTodo.length, c.succOverflow]).toEqual([5, true])
    c.recv({ k: 'rec', rec: r1 }, 'hello')
    c.accept(crV)
    expect(c.succ.map(x => x.new).includes('W')).toBe(true)
    const n = new Contact('V', 'hello', [cert1D1, { k: 'profile1', ik: 'V', byIk: true }])
    n.recv(v2(), 'hello')
    expect([n.st, n.succ.length, n.succTodo.length, n.warning]).toEqual(['none', 0, 0, ''])
  })
  test("R8-succession-size: at n = 8 with 8 keeps, a profile's succ (the succession and the new creation record, no old chain) with a badge fits 4 KiB, the old identity's card with it fits CARD_MAX with up to 3 certs2; with the old chain neither fits", () => {
    let seed = 7
    const bytes = (n: number) => {
      const b = new Uint8Array(n)
      for (let i = 0; i < n; i++) {
        seed = (seed * 1103515245 + 12345) >>> 0
        b[i] = seed >>> 24
      }
      return b
    }
    const b64u = (b: Uint8Array) => Buffer.from(b).toString('base64url')
    const key = () => b64u(bytes(32)),
      sig = () => b64u(bytes(64))
    const canon = (x: unknown): string =>
      Array.isArray(x)
        ? '[' + x.map(canon).join(',') + ']'
        : x && typeof x === 'object'
          ? '{' +
            Object.keys(x)
              .sort()
              .map(k => JSON.stringify(k) + ':' + canon((x as any)[k]))
              .join(',') +
            '}'
          : JSON.stringify(x)
    const len = (x: unknown) => Buffer.byteLength(canon(x))
    const cardLen = (x: unknown) =>
      ('rcp1.' + b64u(new Uint8Array(deflateRawSync(Buffer.from(canon(x)))))).length
    const at = 1762400000000,
      Vk = key(),
      Wk = key()
    const cr = (ik: string) => ({
      v: 1,
      ik,
      n: 0,
      rk: key(),
      pk: key(),
      at,
      sig_ik: sig(),
      sig_rk: sig(),
    })
    const rec = (n: number) => ({
      v: 1,
      ik: Vk,
      n,
      prev: key(),
      pk: key(),
      keep: Array.from({ length: 8 }, key),
      at,
      sig: sig(),
    })
    const chain = [cr(Vk), ...Array.from({ length: 8 }, (_, i) => rec(i + 1))]
    const succ = {
      v: 2,
      old: Vk,
      head: { n: 8, d: key() },
      new: Wk,
      new_cr: key(),
      at,
      sig_old: sig(),
      sig_new: sig(),
    }
    const binding = 'x'.repeat(600)
    // fix round 5 (r8e completeness review M3): `succ` and `succ_cr` are sibling fields of the profile content and of the
    // card, never `succ_cr` inside the closed succession
    const profile = (x: { succ_cr?: unknown; chain?: unknown } & Record<string, unknown>) => {
      const { succ_cr, chain, ...sc } = x
      return len({
        name: 'A name of thirty-two characters!',
        color: '#336699',
        binding,
        succ: chain ? { ...sc, chain } : sc,
        ...(succ_cr ? { succ_cr } : {}),
      })
    }
    const cert = (v: number) => ({
      v,
      ik: Vk,
      dk: key(),
      ...(v === 2 ? { pk: key(), n: 8 } : {}),
      created: at,
      label: 'Browser',
      sig: sig(),
    })
    const oldCard = (
      k: number,
      x: { succ_cr?: unknown; chain?: unknown } & Record<string, unknown>
    ) => {
      const { succ_cr, chain: ch, ...sc } = x
      return cardLen({
        v: 1,
        ik: Vk,
        cr: chain[0],
        head: { n: 8, d: key() },
        certs: [cert(1)],
        certs2: Array.from({ length: k }, () => cert(2)),
        name: 'A name',
        sig_host: 'chat.example.org',
        succ: ch ? { ...sc, chain: ch } : sc,
        ...(succ_cr ? { succ_cr } : {}),
      })
    }
    expect(profile({ ...succ, succ_cr: cr(Wk) })).toBeLessThanOrEqual(4096)
    expect(oldCard(3, { ...succ, succ_cr: cr(Wk) })).toBeLessThanOrEqual(2048)
    expect(profile({ ...succ, succ_cr: cr(Wk), chain })).toBeGreaterThan(4096)
    expect(oldCard(0, { ...succ, succ_cr: cr(Wk), chain: chain.slice(1) })).toBeGreaterThan(2048)
    expect(len(chain)).toBeLessThanOrEqual(6 * 1024) // the hello's keys (and the new identity's keys_old): 9 records, 6 KiB
  })
  // completeness review M1: three proof rules the vectors missed (the reviewer's surviving mutants)
  test('R8-cr-proof-kinds: two distinct v1 certificates are proof that ik is in use, and so is a succession v1; a repeated v1 certificate is not; succession claims are deduplicated by (old, new)', () => {
    const a = new Contact('L', 'carried', [{ k: 'cert1', ik: 'L', dk: 'L1', byIk: true }])
    a.recv({ k: 'cert1', ik: 'L', dk: 'L1', byIk: true }, 'hello')
    expect(a.st).toBe('unknown')
    a.recv({ k: 'cert1', ik: 'L', dk: 'L2', byIk: true }, 'hello')
    expect(a.st).toBe('none')
    const b = new Contact('L', 'carried', [{ k: 'cert1', ik: 'L', dk: 'L1', byIk: true }])
    b.recv(
      { k: 'succ1', old: 'L', new: crW, newCr: crD(crW), byOldIk: true, byNewRk: true },
      'hello'
    )
    b.recv(
      { k: 'succ1', old: 'L', new: crW, newCr: crD(crW), byOldIk: true, byNewRk: true },
      'card'
    )
    expect([b.st, b.succ.length]).toEqual(['none', 1])
  })
  // attack review M6: an unknown contact's held chain records are bounded per claim and go with the claims
  test('R8-held-records: an unknown contact holds at most CHAIN_MAX + 1 records per claim (and as many attached to none); proof drops them with the claims', () => {
    const c = new Contact('L', 'carried', [{ k: 'cert1', ik: 'L', dk: 'L1', byIk: true }])
    const crT: CR = { ik: 'L', rk: 'rkT', pk: 'pT', byIk: true, byRk: true }
    c.recv({ k: 'cr', cr: crT }, 'hello')
    let prev = crD(crT)
    for (let n = 1; n <= 20; n++) {
      const r: Rec = { ik: 'L', n: Math.min(n, CHAIN_MAX), prev, by: 'rkT', pk: `pT${n}`, keep: [] }
      c.recv({ k: 'rec', rec: r }, 'hello')
      prev = recD(r)
    }
    for (let i = 0; i < 20; i++)
      c.recv(
        { k: 'rec', rec: { ik: 'L', n: 1, prev: `cX${i}`, by: 'rkX', pk: `pX${i}`, keep: [] } },
        'hello'
      )
    expect(c.held.length).toBeLessThanOrEqual(2 * (CHAIN_MAX + 1))
    c.recv({ k: 'profile1', ik: 'L', byIk: true }, 'hello')
    expect([c.st, c.claims.length, c.held.length]).toEqual(['none', 0, 0])
  })
})

describe('contacts: a fuzz of message orders', () => {
  // the messages of one history: V's card or a stripped one, V's records (recovery r1 keeping D2, a v2 certificate of D3
  // under pk1), the thief's (keyless hellos from D1, p0-signed certificates and revocations, a badge for the old head),
  // and, for L, a hot-ik thief's minted record and L's proof
  const lcg = (s: number) => () => (s = (Math.imul(s, 1103515245) + 12345) >>> 0) / 2 ** 32
  const shuffle = <X>(xs: X[], r: () => number) => {
    const a = [...xs]
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(r() * (i + 1))
      ;[a[i], a[j]] = [a[j], a[i]]
    }
    return a
  }
  const msgsV = (): [Msg, 'hello' | 'card' | 'server' | 'qr'][] => [
    [{ k: 'rec', rec: r1 }, 'hello'],
    [{ k: 'cert2', ik: 'V', dk: 'D3', n: 1, pk: 'pk1', by: 'pk1' }, 'hello'],
    [{ k: 'cert2', ik: 'V', dk: 'T3', n: 0, pk: 'p0', by: 'p0' }, 'hello'],
    [{ k: 'rev2', ik: 'V', dk: 'D2', n: 0, pk: 'p0', by: 'p0' }, 'hello'],
    [{ k: 'rev2', ik: 'V', dk: 'D3', n: 1, pk: 'pk1', by: 'p0' }, 'hello'],
    [{ k: 'cert1', ik: 'V', dk: 'D1', byIk: true }, 'hello'],
    [{ k: 'cr', cr: { ...crV, rk: 'rkT' } }, 'server'],
    [
      { k: 'badge', tok: { sub: 'mallory@inst', ik: 'V', head: { n: 0, d: crD(crV) }, iat: 9 } },
      'hello',
    ],
    [{ k: 'badge', tok: { sub: 'v@inst', ik: 'V', head: { n: 1, d: recD(r1) }, iat: 5 } }, 'hello'],
  ]
  test("FZ-contacts: in every order a known contact ends with the same trusted devices (D2, D3) and the user's badge, and trusts no thief device once record 1 is held", () => {
    let runs = 0
    for (let seed = 1; seed <= 400; seed++) {
      const r = lcg(seed)
      const c = new Contact('V', 'card', card())
      let trusted0 = new Set<string>()
      for (const [m, src] of shuffle(msgsV(), r)) {
        c.recv(m, src)
        const tr = c.trusted()
        // once record 1 is held, the stolen D1 and the thief's p0-certified T3 are never trusted again (before it, the
        // stolen primary acts in its epoch, as any primary theft does)
        if (c.chain()!.top >= 1)
          expect([tr.includes('D1'), tr.includes('T3')]).toEqual([false, false])
        trusted0 = new Set(tr)
      }
      expect([[...trusted0].sort(), c.badge?.sub, c.st, c.cr]).toEqual([
        ['D2', 'D3'],
        'v@inst',
        'known',
        crV,
      ])
      runs++
    }
    expect(runs).toBe(400)
  })
  test("FZ-contacts: from a stripped card, in every order V's record is never pinned without a check, and never refused as an impersonation; a QR then pins it and the end state is the known one", () => {
    for (let seed = 401; seed <= 800; seed++) {
      const r = lcg(seed)
      const c = new Contact('V', 'card', stripped())
      const ms: [Msg, 'hello' | 'card' | 'server' | 'qr'][] = [
        ...msgsV().filter(([m]) => m.k !== 'cr'),
        [{ k: 'cr', cr: crV }, 'hello'],
        [{ k: 'cert1', ik: 'V', dk: 'D1', byIk: true }, 'hello'],
      ]
      for (const [m, src] of shuffle(ms, r)) c.recv(m, src)
      expect([c.st, c.warning]).toEqual(['unknown', ''])
      c.recv({ k: 'cr', cr: crV }, 'qr')
      expect([c.st, c.trusted()]).toEqual(['known', ['D2', 'D3']])
    }
  })
  test("FZ-succession (fix round 4): in every order, a known contact and a carried one (after Accept) end with V's own v2 move only: the old phrase's v2 dies once the reset is held, the stolen primary's never counts, nothing stays held", () => {
    const crW: CR = { ik: 'W', rk: 'rkW', pk: 'pW', byIk: true, byRk: true }
    const r2: Rec = {
      ik: 'V',
      n: 2,
      prev: recD(r1),
      by: 'rkV',
      rk: 'rkV2',
      pk: 'pk2',
      keep: ['D2'],
    }
    const mv = (head: string, by: string, nw: CR): Msg => ({
      k: 'succ2',
      old: 'V',
      head,
      by,
      chain: [],
      new: nw,
      newCr: crD(nw),
      byNewRk: true,
    })
    const WT: CR = { ...crW, ik: 'WT', rk: 'rkWT' },
      WP: CR = { ...crW, ik: 'WP', rk: 'rkWP' }
    const ms: [Msg, 'hello' | 'card'][] = [
      [{ k: 'rec', rec: r1 }, 'hello'],
      [{ k: 'rec', rec: r2 }, 'hello'],
      [mv(recD(r2), 'rkV2', crW), 'card'], // V's own move after its reset (no old chain: the card)
      [mv(recD(r1), 'rkV', WT), 'hello'], // the leaked old phrase's move: dead once r2 is held
      [mv(crD(crV), 'p0', WP), 'hello'], // the stolen epoch-0 primary: never a v2 signer
    ]
    for (let seed = 1201; seed <= 1600; seed++) {
      const r = lcg(seed)
      for (const carried of [false, true]) {
        const c = carried
          ? new Contact('V', 'carried', [cert1D1])
          : new Contact('V', 'card', card())
        const order = shuffle(
          carried ? [...ms, [{ k: 'cr', cr: crV }, 'hello'] as [Msg, 'hello']] : ms,
          r
        )
        let resetSeen = false
        for (const [m, src] of order) {
          c.recv(m, src)
          if (m.k === 'rec' && m.rec === r2) resetSeen = true
          if (resetSeen && c.st === 'known') expect(c.succ.some(x => x.new === 'WT')).toBe(false)
          expect(c.succ.some(x => x.new === 'WP')).toBe(false)
        }
        if (carried) expect(c.accept(crV)).toBe(true)
        expect([c.st, c.succ.map(x => x.new), c.succTodo.length]).toEqual(['known', ['W'], 0])
      }
    }
  })
  test("FZ-contacts: for a legacy identity, in every order, the thief's minted record is never pinned once L's proof is held, and a claim it made earlier is refused", () => {
    for (let seed = 801; seed <= 1200; seed++) {
      const r = lcg(seed)
      const crZ: CR = { ik: 'L', rk: 'rkZ', pk: 'pZ', byIk: true, byRk: true }
      const ms: [Msg, 'hello' | 'card' | 'qr' | 'server'][] = [
        [{ k: 'cr', cr: crZ }, 'hello'],
        [
          { k: 'rec', rec: { ik: 'L', n: 1, prev: crD(crZ), by: 'rkZ', pk: 'pZ1', keep: ['Z1'] } },
          'hello',
        ],
        [{ k: 'profile1', ik: 'L', byIk: true }, 'hello'],
        [{ k: 'cert1', ik: 'L', dk: 'L1', byIk: true }, 'hello'],
        [{ k: 'cr', cr: crZ }, 'server'],
      ]
      const c = new Contact('L', 'carried', [])
      let proofSeen = false
      for (const [m, src] of shuffle(ms, r)) {
        c.recv(m, src)
        if (m.k === 'profile1') proofSeen = true
        if (proofSeen) expect([c.st, c.cr, c.claims.length]).toEqual(['none', undefined, 0])
      }
      // a QR of the thief's record (sent remotely) can't protect L in place either
      c.recv({ k: 'cr', cr: crZ }, 'qr')
      expect([c.st, c.trusted()]).toEqual(['none', ['L1']])
    }
  })
})

describe("contacts, fix round 5 (the controller's ruling 5; r8e attack review I4, M1, M2; completeness review M2, M5)", () => {
  const lcg = (s: number) => () => (s = (Math.imul(s, 1103515245) + 12345) >>> 0) / 2 ** 32
  const shuffle = <X>(xs: X[], r: () => number) => {
    const a = [...xs]
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(r() * (i + 1))
      ;[a[i], a[j]] = [a[j], a[i]]
    }
    return a
  }
  const crW: CR = { ik: 'W', rk: 'rkW', pk: 'pW', byIk: true, byRk: true }
  const WT: CR = { ...crW, ik: 'WT', rk: 'rkWT' },
    WP: CR = { ...crW, ik: 'WP', rk: 'rkWP' }
  const mv = (
    head: string,
    by: string,
    nw: CR,
    chain: Rec[] = []
  ): Extract<Msg, { k: 'succ2' }> => ({
    k: 'succ2',
    old: 'V',
    head,
    by,
    chain,
    new: nw,
    newCr: crD(nw),
    byNewRk: true,
  })
  const r2: Rec = { ik: 'V', n: 2, prev: recD(r1), by: 'rkV', rk: 'rkV2', pk: 'pk2', keep: ['D2'] }
  const DEAD =
    'This move was signed with a backup phrase V has since replaced. Verify it in person.'
  test("R8-succession-accepted-dead (attack review I4): the old phrase's v2 accepted before the reset arrives is marked dead with the warning, still listed; Accept can't bring it back, Verify can; a verified one stays (mutant ct-acc-keep)", () => {
    const c = new Contact('V', 'card', card([{ k: 'rec', rec: r1 }]))
    c.recv(mv(recD(r1), 'rkV', WT), 'hello')
    c.acceptSucc('WT', false)
    c.recv({ k: 'rec', rec: r2 }, 'hello')
    expect([
      c.succ.map(x => [x.new, !!x.dead, !!x.accepted]),
      c.warning,
      c.log.includes('accepted succession 2 dead: its head or key died'),
    ]).toEqual([[['WT', true, true]], DEAD, true])
    expect(c.acceptSucc('WT', false)).toBeUndefined()
    expect(c.acceptSucc('WT', true)?.dead).toBe(false)
    const v = new Contact('V', 'card', card([{ k: 'rec', rec: r1 }]))
    v.recv(mv(recD(r1), 'rkV', WT), 'hello')
    v.acceptSucc('WT', true)
    v.recv({ k: 'rec', rec: r2 }, 'hello')
    expect([v.succ.map(x => [x.new, !!x.dead]), v.warning]).toEqual([[['WT', false]], ''])
  })
  test("FZ-succession-accept (attack review I4): in every order, the user accepting every claim it sees, once the reset is attached the old phrase's move is gone or dead (with the warning), and V's own move is never dead", () => {
    const ms: [Msg, 'hello' | 'card'][] = [
      [{ k: 'rec', rec: r1 }, 'hello'],
      [{ k: 'rec', rec: r2 }, 'hello'],
      [mv(recD(r2), 'rkV2', crW), 'card'],
      [mv(recD(r1), 'rkV', WT), 'hello'],
      [mv(crD(crV), 'rkV', WT), 'hello'],
      [mv(crD(crV), 'p0', WP), 'hello'],
    ]
    let acceptedThenDead = 0
    for (let seed = 1601; seed <= 2400; seed++) {
      const r = lcg(seed)
      for (const carried of [false, true]) {
        const c = carried
          ? new Contact('V', 'carried', [cert1D1])
          : new Contact('V', 'card', card())
        const order = shuffle(
          carried ? [...ms, [{ k: 'cr', cr: crV }, 'hello'] as [Msg, 'hello']] : ms,
          r
        )
        let wtAccepted = false
        const resetHeld = () => c.st === 'known' && !!c.chain()!.at.get(recD(r2))
        for (const [m, src] of order) {
          c.recv(m, src)
          if (carried && c.st === 'unknown' && c.claims.length === 1 && r() < 0.5) c.accept(crV)
          for (const x of c.succ)
            if (!x.accepted && r() < 0.5) {
              c.acceptSucc(x.new, false)
              if (x.new === 'WT' && !resetHeld()) wtAccepted = true
            }
          if (resetHeld()) {
            const wt = c.succ.find(x => x.new === 'WT')
            expect(!wt || wt.dead === true).toBe(true)
            if (wt) expect(c.warning).toBe(DEAD)
            expect(c.succ.find(x => x.new === 'W')?.dead ?? false).toBe(false)
          }
          expect(c.succ.some(x => x.new === 'WP')).toBe(false)
        }
        if (wtAccepted && c.st === 'known') acceptedThenDead++
      }
    }
    expect(acceptedThenDead).toBeGreaterThan(50)
  })
  test("R8-succession-chain-order (attack review M1): V's move naming its reset, with its old chain, survives every order of the chain records arriving one at a time (mutant ct-succ-chain-drop)", () => {
    const rr: Rec = {
      ik: 'V',
      n: 2,
      prev: recD(r1),
      by: 'rkV',
      rk: 'rkV2',
      pk: 'pk2',
      keep: ['D2'],
    }
    const m: [Msg, 'hello'][] = [
      [mv(recD(rr), 'rkV2', crW, [r1, rr]), 'hello'],
      [{ k: 'rec', rec: r1 }, 'hello'],
      [{ k: 'rec', rec: rr }, 'hello'],
    ]
    const perms = [
      [0, 1, 2],
      [0, 2, 1],
      [1, 0, 2],
      [1, 2, 0],
      [2, 0, 1],
      [2, 1, 0],
    ]
    for (const p of perms) {
      const c = new Contact('V', 'card', card())
      for (const i of p) c.recv(m[i][0], m[i][1])
      expect([p.join(''), c.succ.map(x => x.new)]).toEqual([p.join(''), ['W']])
    }
  })
  test("R8-succession-held-flood (attack review M2): four strangers' v2s fill a carried contact's held slots; V's genuine v2 is still held (the oldest held one goes), with its chain at a known contact it checks at once, and held claims expire after 30 days (mutants ct-held-block, ct-held-forever)", () => {
    const fake = (i: number) => mv(`kFAKE${i}`, `rkF${i}`, { ...crW, ik: `F${i}`, rk: `rkF${i}` })
    const c = new Contact('V', 'carried', [cert1D1])
    c.recv({ k: 'cr', cr: crV }, 'hello')
    for (let i = 0; i < 4; i++) c.recv(fake(i), 'hello')
    c.recv(mv(recD(r1), 'rkV', crW), 'hello')
    expect([c.succTodo.length, c.succTodo.some(x => x.m.new.ik === 'W')]).toEqual([4, true])
    c.recv({ k: 'rec', rec: r1 }, 'hello')
    expect(c.accept(crV)).toBe(true)
    expect(c.succ.map(x => x.new)).toEqual(['W'])
    const k = new Contact('V', 'card', card())
    for (let i = 0; i < 4; i++) k.recv(fake(i), 'hello')
    k.recv(mv(recD(r1), 'rkV', crW, [r1]), 'hello')
    expect([k.succ.map(x => x.new), k.succTodo.length]).toEqual([['W'], 4])
    k.now = 31 * 86_400_000
    k.recv({ k: 'profile2', ik: 'V', n: 1, pk: 'pk1', by: 'pk1', name: 'V', updated: 1 }, 'hello')
    expect(k.succTodo.length).toBe(0)
  })
  test('R8-cr-claims-dedupe (completeness review M5): the same creation record from a hello and then a card is one claim, with no impersonation warning, and Accept works (mutant ct-cr-nodedupe)', () => {
    const c = new Contact('V', 'carried', [cert1D1])
    c.recv({ k: 'cr', cr: crV }, 'hello')
    c.recv({ k: 'cr', cr: crV }, 'card')
    expect([c.claims.length, c.warning]).toEqual([1, ''])
    expect(c.accept(crV)).toBe(true)
  })
  test("R8-safety-two-claims (completeness review M5): with two pending claims the safety screen shows no number ('Scan their code'), never the first claim's (mutant ct-safety-two)", () => {
    const c = new Contact('V', 'carried', [cert1D1])
    c.recv({ k: 'cr', cr: crV }, 'hello')
    c.recv({ k: 'cr', cr: { ...crV, rk: 'rkT' } }, 'hello')
    expect([c.claims.length, c.safetyHalf()]).toEqual([2, 'scan'])
  })
  test('R8-restore-noaccount (completeness review M5): a frozen id beside a stale one restores as frozen with the move, not keep-fetching (mutant ct-restore-rank)', () => {
    const reset: Rec = {
      ik: 'V',
      n: 1,
      prev: crD(crV),
      by: 'rkV',
      rk: 'rkV2',
      pk: 'pkU',
      keep: ['D2'],
    }
    const rival: Rec = {
      ik: 'V',
      n: 1,
      prev: crD(crV),
      by: 'rkV',
      rk: 'rkZ',
      pk: 'pkZ',
      keep: ['Z1'],
    }
    const crU: CR = { ik: 'U', rk: 'rkV2', pk: 'pU', byIk: true, byRk: true }
    const fetched: Msg[] = [
      { k: 'cr', cr: crV },
      { k: 'rec', rec: reset },
      { k: 'rec', rec: rival },
      { k: 'cr', cr: crU },
      {
        k: 'rec',
        rec: { ik: 'U', n: 1, prev: crD(crU), by: 'rkV2', rk: 'rkU3', pk: 'pU1', keep: ['U1'] },
      },
    ]
    expect(restore('rkV2', ['U', 'V'], fetched, 'N', 'pkN')).toMatchObject({
      ok: false,
      why: 'frozen',
      ik: 'V',
    })
  })
  test('R8-backup-delete (completeness review M2, M5): one version is deleted only with re-auth and its number is never reused; GET of the latest returns its number', () => {
    const b = new Backups()
    for (let i = 0; i < 3; i++) expect(b.put('V', `blob${i}`, i * 1000)).toBe('ok')
    expect(b.latest('V')).toEqual({ version: 3, blob: 'blob2' })
    expect(b.delete('V', 3)).toBe('reauth')
    expect(b.delete('V', 3, true)).toBe('ok')
    expect(b.list('V').map(x => x.version)).toEqual([1, 2])
    expect(b.put('V', 'late', 4000, 4, 3)).toBe('conflict')
    expect(b.put('V', 'next', 5000)).toBe('ok')
    expect(b.latest('V')).toEqual({ version: 4, blob: 'next' })
  })
})

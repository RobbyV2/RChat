// The contact, badge, succession and restore vectors of spec r8f 1.7 (R8-*) and the fuzzes of
// message orders (FZ-*), as the model's contacts.test.ts has them, run on production's
// `ContactClaims` over real keys and records (p2p_contact_claims_model.ts turns the model's
// names into them and runs the model beside every step). The instance's vectors (backups, the
// identity record) are plan K's. Then the r8e review's attack cases, and what the model leaves
// to the implementation. FZ_ORDERS multiplies the orders each fuzz tries, FZ_SEED moves them.
import { describe, expect, test } from 'bun:test'
import { deflateRawSync } from 'node:zlib'
import { sha512 } from '@noble/hashes/sha2.js'
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
  ownHalf,
  halfOf,
  CHAIN_MAX,
  shownName,
  serverSuccClaims,
  creation,
  dkOf,
  ikOf,
  kOf,
  realMsg,
  record,
} from './p2p_contact_claims_model'
import { b64u, utf8 } from '../p2p/canonical'
import { recordId, type ChainRecord } from '../p2p/chain'
import {
  BADGES_HELD,
  CERTS2_MAX,
  CLAIMS_MAX,
  ContactClaims,
  HELD_MS,
  HELD_RECORDS,
  MANY_MOVES,
  MANY_RECORDS,
  PROFILES2_MAX,
  rankRestore,
  REVS2_MAX,
  SCAN,
  tokenOk,
  warningText,
  type ClaimMsg,
} from '../p2p/contact_claims'

const ORDERS = Number(process.env.FZ_ORDERS ?? 1)
const SEED = Number(process.env.FZ_SEED ?? 0)
const seeds = (from: number, to: number) =>
  Array.from({ length: (to - from + 1) * ORDERS }, (_, i) => SEED + from + i)

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
})

describe("contacts: fix round 4 (the controller's rulings 3 and 4 on the r8d reviews; completeness review I2, I3, M1; attack review M3, M6)", () => {
  const crW: CR = { ik: 'W', rk: 'rkW', pk: 'pW', byIk: true, byRk: true }
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
              .map(k => JSON.stringify(k) + ':' + canon((x as Record<string, unknown>)[k]))
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
    for (const seed of seeds(1, 400)) {
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
    expect(runs).toBe(400 * ORDERS)
  }, 1_200_000)
  test("FZ-contacts: from a stripped card, in every order V's record is never pinned without a check, and never refused as an impersonation; a QR then pins it and the end state is the known one", () => {
    for (const seed of seeds(401, 800)) {
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
  }, 1_200_000)
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
    for (const seed of seeds(1201, 1600)) {
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
  }, 1_200_000)
  test("FZ-contacts: for a legacy identity, in every order, the thief's minted record is never pinned once L's proof is held, and a claim it made earlier is refused", () => {
    for (const seed of seeds(801, 1200)) {
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
  }, 1_200_000)
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
    for (const seed of seeds(1601, 2400)) {
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
  }, 1_200_000)
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
})

// ----- The r8e review's attack cases -----

describe('r8e attack cases on contacts', () => {
  const WT: CR = { ik: 'WT', rk: 'rkWT', pk: 'pWT', byIk: true, byRk: true }
  const W: CR = { ik: 'W', rk: 'rkW', pk: 'pW', byIk: true, byRk: true }
  const DEAD =
    'This move was signed with a backup phrase V has since replaced. Verify it in person.'
  const mv = (head: string, by: string, nw: CR, chain: Rec[] = []): Msg => ({
    k: 'succ2',
    old: 'V',
    head,
    by,
    chain,
    new: nw,
    newCr: crD(nw),
    byNewRk: true,
  })
  const show = (K: Contact) =>
    K.succ.map(
      c => `${c.new}${c.accepted ? '+acc' : ''}${c.verified ? '+ver' : ''}${c.dead ? '+dead' : ''}`
    )

  test('r8e attack I4 (k1-succ-accepted): a move by the old phrase accepted before the reset arrives is marked dead with the warning; unaccepted it is dropped', () => {
    const reset: Rec = {
      ik: 'V',
      n: 1,
      prev: crD(crV),
      by: 'rkV',
      rk: 'rkV2',
      pk: 'pV2',
      keep: ['D1'],
    }
    for (const accept of [false, true]) {
      const K = new Contact('V', 'card', [{ k: 'cr', cr: crV }, cert1D1])
      K.recv(mv(crD(crV), 'rkV', WT), 'hello')
      expect(show(K)).toEqual(['WT'])
      if (accept) K.acceptSucc('WT', false)
      K.recv({ k: 'rec', rec: reset }, 'hello')
      expect([show(K), K.warning]).toEqual(accept ? [['WT+acc+dead'], DEAD] : [[], ''])
    }
    const K = new Contact('V', 'card', [{ k: 'cr', cr: crV }, cert1D1])
    K.recv(
      { k: 'rec', rec: { ik: 'V', n: 1, prev: crD(crV), by: 'rkV', pk: 'pT', keep: ['T9'] } },
      'hello'
    )
    expect(K.trusted()).toEqual(['T9'])
    K.recv({ k: 'rec', rec: reset }, 'hello')
    expect([K.trusted(), K.warning]).toEqual([['D1'], ''])
  })

  test("r8e attack I4 (the verifier's repro): the leak before the reset, a carried contact, rival resets, and a backdated reset at the cap", () => {
    const r1: Rec = { ik: 'V', n: 1, prev: crD(crV), by: 'rkV', pk: 'pk1', keep: ['D2'] }
    const r2: Rec = {
      ik: 'V',
      n: 2,
      prev: recD(r1),
      by: 'rkV',
      rk: 'rkV2',
      pk: 'pk2',
      keep: ['D2'],
    }
    const outcome = {
      none: [[], ''],
      accept: [['WT+acc+dead'], DEAD],
      verify: [['WT+acc+ver'], ''],
    }
    for (const how of ['none', 'accept', 'verify'] as const) {
      const K = new Contact('V', 'card', [{ k: 'cr', cr: crV }, cert1D1, { k: 'rec', rec: r1 }])
      K.recv(mv(recD(r1), 'rkV', WT), 'hello')
      expect(show(K)).toEqual(['WT'])
      if (how !== 'none') K.acceptSucc('WT', how === 'verify')
      K.recv({ k: 'rec', rec: r2 }, 'hello')
      expect([show(K), K.warning]).toEqual(outcome[how])
      const late = new Contact('V', 'card', [
        { k: 'cr', cr: crV },
        cert1D1,
        { k: 'rec', rec: r1 },
        { k: 'rec', rec: r2 },
      ])
      late.recv(mv(recD(r1), 'rkV', WT), 'hello')
      expect(show(late)).toEqual([])
    }

    const reset: Rec = {
      ik: 'V',
      n: 1,
      prev: crD(crV),
      by: 'rkV',
      rk: 'rkV2',
      pk: 'pk1',
      keep: ['D2'],
    }
    const B = new Contact('V', 'carried', [cert1D1])
    B.recv({ k: 'cr', cr: crV }, 'hello')
    B.recv(mv(crD(crV), 'rkV', WT), 'hello')
    B.accept(crV)
    B.acceptSucc('WT', false)
    B.recv({ k: 'rec', rec: reset }, 'hello')
    expect([show(B), B.warning]).toEqual([['WT+acc+dead'], DEAD])

    const rival: Rec = {
      ik: 'V',
      n: 1,
      prev: crD(crV),
      by: 'rkV',
      rk: 'rkT',
      pk: 'pT',
      keep: ['T9'],
    }
    const C = new Contact('V', 'card', [
      { k: 'cr', cr: crV },
      cert1D1,
      { k: 'rec', rec: reset },
      { k: 'rec', rec: rival },
    ])
    C.recv(mv(recD(rival), 'rkT', WT), 'hello')
    C.acceptSucc('WT', false)
    expect([show(C), C.trusted(), C.warning.startsWith("Someone has V's backup phrase")]).toEqual([
      ['WT+acc'],
      [],
      true,
    ])

    const recs: Rec[] = []
    let prev = crD(crV)
    for (let n = 1; n <= 8; n++) {
      const r: Rec = { ik: 'V', n, prev, by: 'rkV', pk: `pk${n}`, keep: ['D2'] }
      recs.push(r)
      prev = recD(r)
    }
    const backdated: Rec = {
      ik: 'V',
      n: 3,
      prev: recD(recs[1]),
      by: 'rkV',
      rk: 'rkT',
      pk: 'pT',
      keep: ['T9'],
    }
    const atCap = { none: [[], ''], accept: [['W+acc+dead'], DEAD], verify: [['W+acc+ver'], ''] }
    for (const how of ['none', 'accept', 'verify'] as const) {
      const K = new Contact('V', 'card', [
        { k: 'cr', cr: crV },
        cert1D1,
        ...recs.map(rec => ({ k: 'rec', rec }) as Msg),
      ])
      K.recv(mv(recD(recs[7]), 'rkV', W), 'card')
      if (how !== 'none') K.acceptSucc('W', how === 'verify')
      K.recv({ k: 'rec', rec: backdated }, 'hello')
      expect([show(K), K.warning, K.trusted()]).toEqual([...atCap[how], ['T9']])
    }
  })

  test('r8e attack M1 (k3-succ-order): a v2 with its chain, and the chain arriving one record at a time: the claim shows in all 6 orders', () => {
    const p1: Rec = { ik: 'V', n: 1, prev: crD(crV), by: 'rkV', pk: 'pV1', keep: ['D2'] }
    const p2: Rec = {
      ik: 'V',
      n: 2,
      prev: recD(p1),
      by: 'rkV',
      rk: 'rkV2',
      pk: 'pV2',
      keep: ['D2'],
    }
    const items: Msg[] = [
      mv(recD(p2), 'rkV2', W, [p1, p2]),
      { k: 'rec', rec: p1 },
      { k: 'rec', rec: p2 },
    ]
    const perms = <X>(a: X[]): X[][] =>
      a.length <= 1
        ? [a]
        : a.flatMap((x, i) => perms([...a.slice(0, i), ...a.slice(i + 1)]).map(p => [x, ...p]))
    const orders = perms(items)
    expect(orders.length).toBe(6)
    for (const order of orders) {
      const K = new Contact('V', 'card', [{ k: 'cr', cr: crV }, cert1D1])
      for (const m of order) K.recv(m, 'hello')
      expect([show(K), K.succTodo.length]).toEqual([['W'], 0])
    }
  })

  test("r8e attack M2 (k2-held-flood): four strangers' held claims never keep V's own move out", () => {
    const p1: Rec = {
      ik: 'V',
      n: 1,
      prev: crD(crV),
      by: 'rkV',
      rk: 'rkV2',
      pk: 'pV2',
      keep: ['D1'],
    }
    const p2: Rec = {
      ik: 'V',
      n: 2,
      prev: recD(p1),
      by: 'rkV2',
      rk: 'rkV3',
      pk: 'pV3',
      keep: ['D1'],
    }
    for (const withChain of [false, true])
      for (const st of ['known', 'carried'] as const)
        for (const flood of [false, true]) {
          const K =
            st === 'known'
              ? new Contact('V', 'card', [{ k: 'cr', cr: crV }, cert1D1])
              : new Contact('V', 'carried', [cert1D1])
          if (flood)
            for (let i = 0; i < 4; i++) {
              const Z: CR = { ik: `Z${i}`, rk: `rkZ${i}`, pk: `pZ${i}`, byIk: true, byRk: true }
              K.recv(mv(`kjunk${i}`, 'anything', Z), 'hello')
            }
          K.recv(mv(recD(p2), 'rkV3', W, withChain ? [p1, p2] : []), 'hello')
          if (st === 'carried') {
            K.recv({ k: 'cr', cr: crV }, 'hello')
            K.accept(crV)
          }
          K.recv({ k: 'rec', rec: p1 }, 'hello')
          K.recv({ k: 'rec', rec: p2 }, 'hello')
          expect([withChain, st, flood, show(K)]).toEqual([withChain, st, flood, ['W']])
          expect(K.succOverflow).toBe(flood && !(st === 'known' && withChain))
        }
  })

  test('r8e completeness M5 (ct-survivors): the claims dedupe, the two-claims safety screen, the accepted move after a reset, the restore ranking', () => {
    const a = new Contact('V', 'carried', [cert1D1])
    a.recv({ k: 'cr', cr: crV }, 'hello')
    a.recv({ k: 'cr', cr: crV }, 'card')
    expect([a.claims.length, a.warning, a.accept(crV)]).toEqual([1, '', true])

    const b = new Contact('V', 'carried', [])
    b.recv({ k: 'cr', cr: crV }, 'hello')
    b.recv({ k: 'cr', cr: { ...crV, rk: 'rkT' } }, 'hello')
    expect(b.safetyHalf()).toBe('scan')

    const c = new Contact('V', 'card', [
      { k: 'cr', cr: crV },
      { k: 'rec', rec: r1 },
    ])
    c.recv(mv(recD(r1), 'rkV', W), 'hello')
    c.acceptSucc('W', false)
    c.recv(
      {
        k: 'rec',
        rec: { ik: 'V', n: 2, prev: recD(r1), by: 'rkV', rk: 'rkV2', pk: 'pk2', keep: ['D2'] },
      },
      'hello'
    )
    expect(show(c)).toEqual(['W+acc+dead'])

    const reset: Rec = {
      ik: 'V',
      n: 1,
      prev: crD(crV),
      by: 'rkV',
      rk: 'rkV2',
      pk: 'pk1',
      keep: ['D2'],
    }
    const crU: CR = { ik: 'U', rk: 'rkV', pk: 'q0', byIk: true, byRk: true }
    const fetched: Msg[] = [
      { k: 'cr', cr: crV },
      { k: 'rec', rec: reset },
      { k: 'rec', rec: { ...reset, rk: 'rkT', pk: 'pT' } },
      { k: 'cr', cr: crU },
      {
        k: 'rec',
        rec: { ik: 'U', n: 1, prev: crD(crU), by: 'rkV', rk: 'rkX', pk: 'q1', keep: [] },
      },
    ]
    expect(restore('rkV', ['U', 'V'], fetched, 'N', 'pN')).toEqual({
      ok: false,
      why: 'frozen',
      ik: 'V',
      head: crD(crV),
    })
  })
})

// ----- What the model leaves to the implementation -----

describe('contact claims over real records', () => {
  const V = ikOf('V')
  const W: CR = { ik: 'W', rk: 'rkW', pk: 'pW', byIk: true, byRk: true }
  const reset: Rec = {
    ik: 'V',
    n: 2,
    prev: recD(r1),
    by: 'rkV',
    rk: 'rkV2',
    pk: 'pk2',
    keep: ['D2'],
  }
  const move = (head: string, by: string, nw: CR, chain: Rec[] = []): Msg => ({
    k: 'succ2',
    old: 'V',
    head,
    by,
    chain,
    new: nw,
    newCr: crD(nw),
    byNewRk: true,
  })
  const real = (ms: Msg[]): ClaimMsg[] => ms.map(realMsg)
  const knownReal = (extra: Msg[] = []) => new ContactClaims(V, 'card', real(card(extra)))
  const carried = (first: Msg[] = [cert1D1]) => new ContactClaims(V, 'carried', real(first))
  const crId = recordId(creation(crV))

  test('the copy is the spec wording', () => {
    expect(warningText('impersonation', 'Vee')).toBe(
      'Someone may be impersonating Vee. Check their safety number.'
    )
    expect(warningText('ik-hot', 'Vee')).toBe(
      "Someone has Vee's identity key. Ask them to move to a new identity."
    )
    expect(warningText('phrase', 'Vee')).toBe(
      "Someone has Vee's backup phrase. Ask them to move to a new identity."
    )
    expect(warningText('move-dead', 'Vee')).toBe(
      'This move was signed with a backup phrase Vee has since replaced. Verify it in person.'
    )
    expect([MANY_RECORDS, MANY_MOVES, SCAN]).toEqual([
      'Many records claimed. Verify in person.',
      'Many moves claimed. Verify in person.',
      'Scan their code.',
    ])
    expect([CLAIMS_MAX, HELD_MS, HELD_RECORDS]).toEqual([4, 30 * 86_400_000, 9])
  })

  test('warnings() lists the warning and both overflow notes', () => {
    const c = carried()
    for (let i = 0; i < 6; i++)
      c.receive(realMsg({ k: 'cr', cr: { ...crV, rk: `rkZ${i}`, pk: `pZ${i}` } }), 'hello')
    for (let i = 0; i < 6; i++)
      c.receive(realMsg(move(recD(r1), 'rkV', { ...W, ik: `J${i}`, rk: `rkJ${i}` })), 'hello')
    expect(c.warnings('Vee')).toEqual([
      'Someone may be impersonating Vee. Check their safety number.',
      MANY_RECORDS,
      MANY_MOVES,
    ])
    expect(knownReal().warnings('Vee')).toEqual([])
    expect(c.half()).toBeNull()
  })

  test('Verify pins one of several pending creation records; Accept only the single one', () => {
    const other: CR = { ...crV, rk: 'rkT', pk: 'pT' }
    const c = carried()
    c.receive(realMsg({ k: 'cr', cr: other }), 'server')
    c.receive(realMsg({ k: 'cr', cr: crV }), 'card')
    c.receive(realMsg({ k: 'rec', rec: r1 }), 'hello')
    expect(c.claims().map(x => x.kind)).toEqual(['cr', 'cr'])
    expect(c.held().recs.length).toBe(1)
    expect(c.accept({ kind: 'cr', id: crId })).toBe(false)
    expect(c.verify({ kind: 'cr', id: 'x' })).toBe(false)
    expect(c.verify({ kind: 'cr', id: crId })).toBe(true)
    expect([c.st, c.claims(), c.warning, c.trusted()]).toEqual(['known', [], null, [dkOf('D2')]])
    expect(c.verify({ kind: 'cr', id: crId })).toBe(false)
    expect(c.undo({ kind: 'cr', id: crId })).toBe(false)
  })

  test('held records that hold rival resets freeze the contact as soon as their claim is pinned', () => {
    const a: Rec = { ik: 'V', n: 1, prev: crD(crV), by: 'rkV', rk: 'rkV2', pk: 'pk1', keep: ['D2'] }
    const b: Rec = { ik: 'V', n: 1, prev: crD(crV), by: 'rkV', rk: 'rkZ', pk: 'pZ', keep: ['Z1'] }
    const c = carried()
    for (const m of [
      { k: 'cr', cr: crV },
      { k: 'rec', rec: a },
      { k: 'rec', rec: b },
    ] as Msg[])
      c.receive(realMsg(m), 'hello')
    expect(c.accept({ kind: 'cr', id: crId })).toBe(true)
    expect([c.trusted(), c.warning]).toEqual([[], 'phrase'])
  })

  test('Undo reverses the merge of a move: a live one is a claim again, a dead one is gone', () => {
    const c = knownReal([{ k: 'rec', rec: r1 }])
    c.receive(realMsg(move(recD(r1), 'rkV', W)), 'hello')
    const ref = { kind: 'succ' as const, new: ikOf('W') }
    expect(c.undo(ref)).toBe(false)
    expect(c.accept(ref)).toBe(true)
    expect(c.claims()).toMatchObject([{ kind: 'succ', new: ikOf('W'), v: 2, accepted: true }])
    expect(c.undo(ref)).toBe(true)
    expect(c.claims()).toMatchObject([{ kind: 'succ', new: ikOf('W') }])
    expect(c.succ[0].accepted).toBeUndefined()
    expect(c.verify(ref)).toBe(true)
    c.receive(realMsg({ k: 'rec', rec: reset }), 'hello')
    expect([c.succ[0].verified, c.succ[0].dead, c.warning]).toEqual([true, false, null])
    expect(c.undo(ref)).toBe(true)
    expect(c.claims()).toEqual([])
    expect(c.accept(ref)).toBe(false)
    expect(c.verify({ kind: 'succ', new: ikOf('Nobody') })).toBe(false)
  })

  test('a dead move can be undone, and then it is gone', () => {
    const c = knownReal([{ k: 'rec', rec: r1 }])
    c.receive(realMsg(move(recD(r1), 'rkV', W)), 'hello')
    const ref = { kind: 'succ' as const, new: ikOf('W') }
    c.accept(ref)
    c.receive(realMsg({ k: 'rec', rec: reset }), 'hello')
    expect([c.succ[0].dead, c.warning, c.accept(ref)]).toEqual([true, 'move-dead', false])
    expect(c.undo(ref)).toBe(true)
    expect(c.succ).toEqual([])
  })

  test('a succession is read only with the creation record it names, a closed format and both signatures', () => {
    const good = realMsg(move(recD(r1), 'rkV', W)) as Extract<ClaimMsg, { k: 'succ' }>
    const fresh = () => knownReal([{ k: 'rec', rec: r1 }])
    const take = (m: ClaimMsg) => {
      const c = fresh()
      c.receive(m, 'hello')
      return c.succ.length + c.held().succ.length
    }
    expect(take(good)).toBe(1)
    expect(take({ ...good, succ_cr: undefined })).toBe(0)
    expect(take({ ...good, succ_cr: creation({ ...W, rk: 'rkOther' }) })).toBe(0)
    expect(take({ ...good, succ: { ...(good.succ as object), succ_cr: good.succ_cr } })).toBe(0)
    expect(take({ ...good, succ: { ...(good.succ as object), note: 1 } })).toBe(0)
    expect(take({ ...good, succ: { ...(good.succ as object), old: ikOf('L') } })).toBe(0)
    expect(take({ ...good, succ: null })).toBe(0)
    expect(take({ ...good, succ: { ...(good.succ as object), head: { n: 0, d: recD(r1) } } })).toBe(
      0
    )
    const byPrimary = realMsg(move(recD(r1), 'pk1', { ...W, ik: 'W9' }))
    expect(take(byPrimary)).toBe(0)
    const badNew = realMsg({ ...move(recD(r1), 'rkV', { ...W, ik: 'W8' }), byNewRk: false } as Msg)
    expect(take(badNew)).toBe(0)
  })

  test("a 0.3.0 succession whose new half doesn't verify is no claim, and still proof that the old key is in use", () => {
    const c = new Contact('L', 'carried', [{ k: 'cert1', ik: 'L', dk: 'L1', byIk: true }])
    c.recv({ k: 'cr', cr: { ik: 'L', rk: 'rkZ', pk: 'pZ', byIk: true, byRk: true } }, 'hello')
    const legacy = { ik: 'L2', rk: '', pk: '', byIk: true, byRk: false }
    c.recv(
      { k: 'succ1', old: 'L', new: legacy, byOldIk: false, byNewRk: false, byNewIk: true },
      'hello'
    )
    expect([c.st, c.claims.length]).toEqual(['unknown', 1])
    c.recv(
      { k: 'succ1', old: 'L', new: legacy, byOldIk: true, byNewRk: false, byNewIk: false },
      'hello'
    )
    expect([c.st, c.claims.length, c.succ.length]).toEqual(['none', 0, 0])
  })

  test('a copy of a chain record with a bad signature never stands in for the record', () => {
    const forged: ChainRecord = { ...record(r1), sig: record({ ...r1, by: 'rkT' }).sig }
    expect(recordId(forged)).toBe(recD(r1))
    for (const order of [
      [forged, record(r1)],
      [record(r1), forged],
    ]) {
      const c = knownReal()
      for (const rec of order) c.receive({ k: 'rec', rec }, 'hello')
      expect([c.chain()!.top, c.trusted()]).toEqual([1, [dkOf('D2')]])
      expect(c.held().recs).toEqual([forged])
    }
    const u = carried()
    u.receive(realMsg({ k: 'cr', cr: crV }), 'hello')
    u.receive({ k: 'rec', rec: forged }, 'hello')
    u.receive({ k: 'rec', rec: record(r1) }, 'hello')
    expect(u.accept({ kind: 'cr', id: crId })).toBe(true)
    expect(u.trusted()).toEqual([dkOf('D2')])
  })

  test('a known contact keeps at most HELD_RECORDS records that attach to nothing, and every one that attaches', () => {
    const c = knownReal()
    for (let i = 0; i < 30; i++)
      c.receive(
        realMsg({
          k: 'rec',
          rec: { ik: 'V', n: 1, prev: `cX${i}`, by: 'rkX', pk: `pX${i}`, keep: [] },
        }),
        'hello'
      )
    expect(c.held().recs.length).toBe(HELD_RECORDS)
    c.receive(realMsg({ k: 'rec', rec: r1 }), 'hello')
    c.receive(realMsg({ k: 'rec', rec: reset }), 'hello')
    expect([c.chain()!.top, c.held().recs.length, c.recs.size]).toEqual([
      2,
      HELD_RECORDS,
      HELD_RECORDS + 2,
    ])
  })

  test('v2 certificates, revocations and profiles are bounded, and the current epoch is kept', () => {
    const c = knownReal([{ k: 'rec', rec: r1 }])
    for (let i = 0; i < CERTS2_MAX + 20; i++)
      c.receive(realMsg({ k: 'cert2', ik: 'V', dk: `T${i}`, n: 0, pk: 'p0', by: 'p0' }), 'hello')
    for (const d of ['D3', 'D4'])
      c.receive(realMsg({ k: 'cert2', ik: 'V', dk: d, n: 1, pk: 'pk1', by: 'pk1' }), 'hello')
    c.receive(realMsg({ k: 'cert2', ik: 'V', dk: 'D3', n: 1, pk: 'pk1', by: 'pk1' }), 'hello')
    expect(c.certs2.length).toBe(CERTS2_MAX)
    expect(c.trusted()).toEqual([dkOf('D2'), dkOf('D3'), dkOf('D4')].sort())
    for (let i = 0; i < REVS2_MAX + 20; i++)
      c.receive(realMsg({ k: 'rev2', ik: 'V', dk: `T${i}`, n: 0, pk: 'p0', by: 'p0' }), 'hello')
    c.receive(realMsg({ k: 'rev2', ik: 'V', dk: 'D4', n: 1, pk: 'pk1', by: 'pk1' }), 'hello')
    c.receive(realMsg({ k: 'rev2', ik: 'V', dk: 'D3', n: 0, pk: 'p0', by: 'rkV' }), 'hello')
    for (let i = 0; i < REVS2_MAX + 20; i++)
      c.receive(realMsg({ k: 'rev2', ik: 'V', dk: `U${i}`, n: 0, pk: 'p0', by: 'p0' }), 'hello')
    expect(c.revs2.length).toBe(REVS2_MAX)
    expect(c.trusted()).toEqual([dkOf('D2')])
    for (let i = 0; i < PROFILES2_MAX + 5; i++)
      c.receive(
        realMsg({
          k: 'profile2',
          ik: 'V',
          n: 0,
          pk: `q${i}`,
          by: `q${i}`,
          name: 'Thief',
          updated: 9,
        }),
        'hello'
      )
    c.receive(
      realMsg({ k: 'profile2', ik: 'V', n: 1, pk: 'pk1', by: 'pk1', name: 'Vera', updated: 2 }),
      'hello'
    )
    c.receive(
      realMsg({ k: 'profile2', ik: 'V', n: 1, pk: 'pk1', by: 'pk1', name: 'Older', updated: 1 }),
      'hello'
    )
    expect([c.profiles2.length, c.name('Vee')]).toEqual([PROFILES2_MAX, 'Vera'])
  })

  test('a v2 record signed by another key than the one it names is not kept', () => {
    const c = knownReal()
    c.receive(realMsg({ k: 'cert2', ik: 'V', dk: 'T1', n: 0, pk: 'p0', by: 'pT' }), 'hello')
    c.receive(
      realMsg({ k: 'profile2', ik: 'V', n: 0, pk: 'p0', by: 'pT', name: 'Thief', updated: 1 }),
      'hello'
    )
    c.receive(realMsg({ k: 'cert2', ik: 'L', dk: 'T2', n: 0, pk: 'p0', by: 'p0' }), 'hello')
    expect([c.certs2.length, c.profiles2.length, c.trusted()]).toEqual([0, 0, [dkOf('D1')]])
  })

  test('tokenOk: a badge token against the heads of the chain', () => {
    const c = knownReal([{ k: 'rec', rec: r1 }])
    const C = c.chain()!
    const tok = (head?: { n: number; d: string }) => ({ sub: 'v@inst', ik: V, iat: 1, head })
    expect(tokenOk(tok(), undefined)).toBe('take')
    expect(tokenOk(tok(), C)).toBe('ignore')
    expect(tokenOk(tok({ n: 1, d: recD(r1) }), C)).toBe('take')
    expect(tokenOk(tok({ n: 0, d: crD(crV) }), C)).toBe('ignore')
    expect(tokenOk(tok({ n: 2, d: recD(reset) }), C)).toBe('wait')
    expect(tokenOk(tok({ n: 1, d: recD(reset) }), C)).toBe('ignore')
    expect(tokenOk(tok({ n: 2, d: recD(r1) }), C)).toBe('ignore')
    for (let i = 0; i < BADGES_HELD + 3; i++)
      c.receive({ k: 'badge', token: { ...tok({ n: 2, d: recD(reset) }), iat: i } }, 'hello')
    expect(c.held().badges.map(t => t.iat)).toEqual([3, 4, 5, 6])
    c.receive({ k: 'badge', token: { ...tok({ n: 1, d: recD(r1) }), ik: ikOf('L') } }, 'hello')
    expect(c.badge).toBeUndefined()
    c.receive(realMsg({ k: 'rec', rec: reset }), 'hello')
    expect([c.badge?.iat, c.held().badges]).toEqual([6, []])
  })

  test('toJSON and parse: every state comes back as it was, through JSON', () => {
    const states: ContactClaims[] = []
    const k = knownReal([{ k: 'rec', rec: r1 }])
    k.receive(realMsg({ k: 'cert2', ik: 'V', dk: 'D3', n: 1, pk: 'pk1', by: 'pk1' }), 'hello')
    k.receive(realMsg({ k: 'rev2', ik: 'V', dk: 'D3', n: 0, pk: 'p0', by: 'rkV' }), 'hello')
    k.receive(
      realMsg({ k: 'profile2', ik: 'V', n: 1, pk: 'pk1', by: 'pk1', name: 'Vera', updated: 2 }),
      'hello'
    )
    k.receive(realMsg(move(recD(r1), 'rkV', W)), 'hello', 5)
    k.receive(realMsg(move(recD(reset), 'rkV2', { ...W, ik: 'W2', rk: 'rkW2' })), 'hello', 7)
    k.accept({ kind: 'succ', new: ikOf('W') })
    k.receive(
      { k: 'badge', token: { sub: 'v@inst', ik: V, iat: 3, head: { n: 1, d: recD(r1) } } },
      'hello'
    )
    k.receive(
      { k: 'badge', token: { sub: 'v@inst', ik: V, iat: 4, head: { n: 2, d: recD(reset) } } },
      'hello'
    )
    states.push(k)
    const u = carried()
    u.receive(realMsg({ k: 'cr', cr: crV }), 'hello')
    u.receive(realMsg({ k: 'cr', cr: { ...crV, rk: 'rkT' } }), 'server')
    u.receive(realMsg({ k: 'rec', rec: r1 }), 'hello')
    u.receive(realMsg(move(recD(r1), 'rkV', W, [r1])), 'card', 9)
    states.push(u)
    const l = new ContactClaims(ikOf('L'), 'hello', real([{ k: 'profile1', ik: 'L', byIk: true }]))
    l.receive(realMsg({ k: 'cert1', ik: 'L', dk: 'L1', byIk: true }), 'hello')
    l.receive(
      realMsg({ k: 'succ1', old: 'L', new: W, newCr: crD(W), byOldIk: true, byNewRk: true }),
      'hello'
    )
    l.receive(
      realMsg({
        k: 'succ1',
        old: 'L',
        new: { ik: 'L2', rk: '', pk: '', byIk: true, byRk: false },
        byOldIk: true,
        byNewRk: false,
        byNewIk: true,
      }),
      'hello'
    )
    l.receive(
      realMsg({ k: 'cr', cr: { ik: 'L', rk: 'rkZ', pk: 'pZ', byIk: true, byRk: true } }),
      'hello'
    )
    states.push(l)
    expect(states.map(c => c.st)).toEqual(['known', 'unknown', 'none'])
    expect([k.succ.length, k.held().succ.length, u.held().succ.length, l.succ.length]).toEqual([
      1, 1, 1, 2,
    ])
    for (const c of states) {
      const text = JSON.stringify(c)
      const back = ContactClaims.parse(JSON.parse(text))!
      expect(JSON.stringify(back)).toBe(text)
      expect(back.trusted()).toEqual(c.trusted())
      expect(back.half()).toBe(c.half())
      expect(back.claims()).toEqual(c.claims())
      expect(back.warnings('V')).toEqual(c.warnings('V'))
    }
    const back = ContactClaims.parse(JSON.parse(JSON.stringify(k)))!
    back.receive(realMsg({ k: 'rec', rec: reset }), 'hello', 8)
    k.receive(realMsg({ k: 'rec', rec: reset }), 'hello', 8)
    expect(JSON.stringify(back)).toBe(JSON.stringify(k))
    expect(back.succ.map(c => [c.dead, c.new])).toEqual([
      [true, ikOf('W')],
      [undefined, ikOf('W2')],
    ])
  })

  test('parse checks every record again and reads nothing it does not know', () => {
    const k = knownReal([{ k: 'rec', rec: r1 }])
    k.receive(realMsg({ k: 'cert2', ik: 'V', dk: 'D3', n: 1, pk: 'pk1', by: 'pk1' }), 'hello')
    k.receive(realMsg(move(recD(r1), 'rkV', W)), 'hello')
    const json = JSON.parse(JSON.stringify(k)) as Record<string, unknown[]> & { cr: object }
    for (const bad of [
      null,
      5,
      'x',
      [],
      {},
      { ...json, v: 2 },
      { ...json, ik: 'x' },
      { ...json, st: 'new' },
    ])
      expect(ContactClaims.parse(bad)).toBeNull()
    expect(ContactClaims.parse({ ...json, cr: { ...json.cr, note: 1 } })).toBeNull()
    expect(
      ContactClaims.parse({
        ...json,
        cr: creation({ ik: 'L', rk: 'rkL', pk: 'pL', byIk: true, byRk: true }),
      })
    ).toBeNull()
    const forgedCert = { ...(json.certs2[0] as object), dk: dkOf('T1') }
    const forgedSucc = { ...(json.succ[0] as object), new: ikOf('WT') }
    const loose = ContactClaims.parse({
      ...json,
      certs2: [forgedCert, 5, ...json.certs2],
      succ: [forgedSucc, null, ...json.succ],
      recs: [{ ...(json.recs[0] as object), note: 1 }, ...json.recs],
      badge: { sub: 5 },
      warning: 'other',
      heldSucc: 'x',
      unread: true,
    })!
    expect(JSON.stringify(loose)).toBe(JSON.stringify(k))
    const none = ContactClaims.parse({
      v: 1,
      ik: V,
      st: 'none',
      pending: [json.cr],
      heldRecs: json.recs,
    })!
    expect([none.st, none.proof, none.claims(), none.held().recs]).toEqual(['none', true, [], []])
  })

  test('rankRestore reads only creation and chain records, and tries every id once', () => {
    const fetched = { crs: [creation(crV), null, { v: 1 }], recs: [record(r1), 'x', { n: 1 }] }
    expect(rankRestore(kOf('rkV'), [V, V, ''], fetched)).toEqual({
      kind: 'record',
      ik: V,
      cr: creation(crV),
      chain: [record(r1)],
      head: { n: 1, d: recD(r1) },
    })
    expect(rankRestore(kOf('rkV'), ['', ''], fetched)).toEqual({ kind: 'none', why: 'no-id' })
    expect(rankRestore(kOf('rkV'), [ikOf('L')], fetched)).toEqual({
      kind: 'none',
      why: 'no-record',
    })
    expect(rankRestore(kOf('rkOther'), [V], fetched)).toEqual({ kind: 'fetch' })
    expect(
      rankRestore(kOf('rkV2'), [V], { crs: [creation(crV)], recs: [record(r1), record(reset)] })
    ).toMatchObject({ kind: 'record', head: { n: 2, d: recD(reset) } })
  })

  const junkSig = (i: number) => b64u(sha512(utf8(`rchat-p2p-contact-test junk ${i}`)))
  const field = (m: ClaimMsg, key: string) => (m as unknown as Record<string, object>)[key]

  test('a value canonical JSON refuses is ignored wherever it comes, never thrown: in a message, the first messages and a stored contact', () => {
    const cert2 = realMsg({ k: 'cert2', ik: 'V', dk: 'D3', n: 1, pk: 'pk1', by: 'pk1' })
    const prof2 = realMsg({
      k: 'profile2',
      ik: 'V',
      n: 1,
      pk: 'pk1',
      by: 'pk1',
      name: 'Vera',
      updated: 2,
    })
    const cert1 = realMsg({ k: 'cert1', ik: 'V', dk: 'D4', byIk: true })
    const rev1 = realMsg({ k: 'rev1', ik: 'V', dk: 'D1', byIk: true })
    const prof1 = realMsg({ k: 'profile1', ik: 'V', byIk: true })
    const rev2 = realMsg({ k: 'rev2', ik: 'V', dk: 'D2', n: 1, pk: 'pk1', by: 'pk1' })
    const succ = realMsg(move(recD(r1), 'rkV', W)) as Extract<ClaimMsg, { k: 'succ' }>
    const bad: ClaimMsg[] = [
      { k: 'cert2', cert: { ...field(cert2, 'cert'), label: '\ud800' } },
      { k: 'cert2', cert: { ...field(cert2, 'cert'), label: 'e\u0301' } },
      { k: 'cert2', cert: { ...field(cert2, 'cert'), created: -0 } },
      { k: 'profile2', profile: { ...field(prof2, 'profile'), name: 'A\ud800' } },
      { k: 'profile2', profile: { ...field(prof2, 'profile'), updated: -0 } },
      { k: 'cert1', cert: { ...field(cert1, 'cert'), label: 'e\u0301' } },
      { k: 'cert1', cert: { ...field(cert1, 'cert'), created: -0 } },
      { k: 'rev1', rev: { ...field(rev1, 'rev'), revoked_at: 1e300 } },
      { k: 'profile1', profile: { ...field(prof1, 'profile'), updated: 1.5 } },
      { k: 'profile1', profile: { ...field(prof1, 'profile'), name: 'A\ud800' } },
      { k: 'rev2', rev: { ...field(rev2, 'rev'), revoked_at: -0 } },
      { k: 'cr', cr: { ...creation(crV), at: -0 } },
      { k: 'rec', rec: { ...record(r1), at: -0 } },
      { ...succ, succ: { ...(succ.succ as object), at: -0 } },
    ]
    const pending = () => {
      const u = carried()
      u.receive(realMsg({ k: 'cr', cr: crV }), 'hello')
      return u
    }
    for (const c of [knownReal([{ k: 'rec', rec: r1 }]), carried(), pending()]) {
      const before = JSON.stringify(c)
      for (const m of bad) expect(() => c.receive(m, 'hello')).not.toThrow()
      expect(JSON.stringify(c)).toBe(before)
    }
    for (const m of bad) {
      expect(() => new ContactClaims(V, 'hello', [m])).not.toThrow()
      expect(new ContactClaims(V, 'hello', [m]).st).toBe('unknown')
    }
    const k = knownReal([{ k: 'rec', rec: r1 }])
    for (const m of [cert2, prof2, succ]) k.receive(m, 'hello')
    const json = JSON.parse(JSON.stringify(k)) as Record<string, Record<string, object>[]>
    const stored = {
      ...json,
      recs: [{ ...json.recs[0], at: -0 }, ...json.recs],
      certs2: [{ ...json.certs2[0], label: '\ud800' }, ...json.certs2],
      profiles2: [{ ...json.profiles2[0], name: 'A\ud800' }, ...json.profiles2],
      revs2: [{ ...field(rev2, 'rev'), revoked_at: -0 }],
      succ: [{ ...json.succ[0], succ: { ...json.succ[0].succ, at: -0 } }, ...json.succ],
    }
    expect(() => ContactClaims.parse(stored)).not.toThrow()
    expect(JSON.stringify(ContactClaims.parse(stored))).toBe(JSON.stringify(k))
    const unknown = {
      v: 1,
      ik: V,
      st: 'unknown',
      certs2: [{ ...json.certs2[0], label: '\ud800' }],
      pending: [{ ...creation(crV), at: -0 }],
      heldRecs: [{ ...record(r1), at: -0 }],
      heldSucc: [
        { succ: { ...json.succ[0].succ, at: -0 }, cr: creation(W), chain: [], src: 'hello', at: 0 },
      ],
    }
    expect(() => ContactClaims.parse(unknown)).not.toThrow()
    expect(JSON.stringify(ContactClaims.parse(unknown))).toBe(JSON.stringify(carried([])))
  })

  test('copies of one chain record with other signatures never grow what an unknown contact holds, and never keep the record out', () => {
    const u = carried()
    u.receive(realMsg({ k: 'cr', cr: crV }), 'hello')
    const loose = record({ ik: 'V', n: 2, prev: 'cX', by: 'rkX', pk: 'pX', keep: [] })
    for (let i = 0; i < 200; i++) {
      u.receive({ k: 'rec', rec: { ...record(r1), sig: junkSig(i) } }, 'hello')
      u.receive({ k: 'rec', rec: { ...loose, sig: junkSig(i) } }, 'hello')
    }
    expect(u.heldRecs.length).toBe(2 * HELD_RECORDS)
    expect((u.toJSON().heldRecs as unknown[]).length).toBe(2 * HELD_RECORDS)
    u.receive(realMsg({ k: 'rec', rec: r1 }), 'hello')
    u.receive(realMsg({ k: 'rec', rec: r1 }), 'hello')
    expect(u.heldRecs.length).toBe(2 * HELD_RECORDS)
    expect(u.heldRecs.map(x => x.sig)).toContain(record(r1).sig)
    expect(u.accept({ kind: 'cr', id: crId })).toBe(true)
    expect([u.chain()!.top, u.trusted()]).toEqual([1, [dkOf('D2')]])
    const k = knownReal()
    for (let i = 0; i < 200; i++)
      k.receive({ k: 'rec', rec: { ...record(r1), sig: junkSig(i) } }, 'hello')
    k.receive(realMsg({ k: 'rec', rec: r1 }), 'hello')
    expect([k.recs.size, k.chain()!.top, k.trusted()]).toEqual([HELD_RECORDS + 1, 1, [dkOf('D2')]])
  })

  test('revocations no key of the chain verifies, or that count at no head, never push out one that counts: a revoked device stays revoked', () => {
    const rb: Rec = { ...r1, keep: ['D2', 'D3'] }
    const rs: Rec = {
      ik: 'V',
      n: 2,
      prev: recD(rb),
      by: 'rkV',
      rk: 'rkV2',
      pk: 'pk2',
      keep: ['D2', 'D3'],
    }
    const flood = (c: ContactClaims, n: number, pk: string) => {
      for (let i = 0; i <= REVS2_MAX; i++) {
        const forged = realMsg({ k: 'rev2', ik: 'V', dk: `T${i}`, n, pk, by: 'pT' })
        c.receive({ k: 'rev2', rev: { ...field(forged, 'rev'), sig: junkSig(i) } }, 'hello')
        c.receive(forged, 'hello')
        c.receive(realMsg({ k: 'rev2', ik: 'V', dk: `U${i}`, n, pk: 'pT', by: 'pT' }), 'hello')
        c.receive(realMsg({ k: 'rev2', ik: 'V', dk: `S${i}`, n: 5, pk: 'p0', by: 'p0' }), 'hello')
      }
    }
    const c = knownReal([{ k: 'rec', rec: rb }])
    expect(c.trusted()).toEqual([dkOf('D2'), dkOf('D3')].sort())
    const real = realMsg({ k: 'rev2', ik: 'V', dk: 'D3', n: 1, pk: 'pk1', by: 'pk1' })
    c.receive({ k: 'rev2', rev: { ...field(real, 'rev'), dk: dkOf('T') } }, 'hello')
    c.receive(real, 'hello')
    expect(c.trusted()).toEqual([dkOf('D2')])
    flood(c, 1, 'pk1')
    expect(c.trusted()).toEqual([dkOf('D2')])
    expect(c.revs2.length).toBe(REVS2_MAX)
    c.receive(realMsg({ k: 'rev2', ik: 'V', dk: 'D3', n: 2, pk: 'pk2', by: 'rkV2' }), 'hello')
    c.receive(realMsg({ k: 'rec', rec: rs }), 'hello')
    expect([c.chain()!.top, c.trusted()]).toEqual([2, [dkOf('D2')]])
    flood(c, 2, 'pk2')
    expect(c.trusted()).toEqual([dkOf('D2')])
    const back = ContactClaims.parse(JSON.parse(JSON.stringify(c)))!
    expect(JSON.stringify(back)).toBe(JSON.stringify(c))
    expect(back.trusted()).toEqual([dkOf('D2')])

    const u = carried()
    u.receive(realMsg({ k: 'cr', cr: crV }), 'hello')
    u.receive(realMsg({ k: 'rec', rec: rb }), 'hello')
    u.receive(realMsg({ k: 'rev2', ik: 'V', dk: 'D3', n: 1, pk: 'pk1', by: 'pk1' }), 'hello')
    flood(u, 1, 'pk1')
    expect(u.accept({ kind: 'cr', id: crId })).toBe(true)
    expect(u.trusted()).toEqual([dkOf('D2')])
  })

  test('v2 certificates and profiles that count at no head (a later epoch, a key the chain lacks) never push out ones that count', () => {
    const c = knownReal([{ k: 'rec', rec: r1 }])
    c.receive(realMsg({ k: 'cert2', ik: 'V', dk: 'D4', n: 1, pk: 'pk1', by: 'pk1' }), 'hello')
    c.receive(
      realMsg({ k: 'profile2', ik: 'V', n: 1, pk: 'pk1', by: 'pk1', name: 'Vera', updated: 2 }),
      'hello'
    )
    for (let i = 0; i <= CERTS2_MAX; i++) {
      c.receive(realMsg({ k: 'cert2', ik: 'V', dk: `S${i}`, n: 5, pk: 'p0', by: 'p0' }), 'hello')
      c.receive(
        realMsg({ k: 'cert2', ik: 'V', dk: `S${i}`, n: 5, pk: `pT${i}`, by: `pT${i}` }),
        'hello'
      )
    }
    for (let i = 0; i <= PROFILES2_MAX; i++)
      c.receive(
        realMsg({
          k: 'profile2',
          ik: 'V',
          n: 5,
          pk: `pT${i}`,
          by: `pT${i}`,
          name: 'Thief',
          updated: 9,
        }),
        'hello'
      )
    expect([c.certs2.length, c.profiles2.length]).toEqual([CERTS2_MAX, PROFILES2_MAX])
    expect([c.trusted(), c.name('Vee')]).toEqual([[dkOf('D2'), dkOf('D4')].sort(), 'Vera'])
  })

  test("a known contact's slots for records that don't attach yet take the newest: a record that comes before its parent still gets in after junk filled them", () => {
    const rs: Rec = {
      ik: 'V',
      n: 2,
      prev: recD(r1),
      by: 'rkV',
      rk: 'rkV2',
      pk: 'pk2',
      keep: ['D3'],
    }
    const junk = (i: number): Rec => ({
      ik: 'V',
      n: 1,
      prev: `cX${i}`,
      by: 'rkX',
      pk: `pX${i}`,
      keep: [],
    })
    const c = knownReal()
    c.receive(
      realMsg(
        move(
          recD(r1),
          'rkT',
          W,
          Array.from({ length: HELD_RECORDS }, (_, i) => junk(i))
        )
      ),
      'hello'
    )
    expect(c.held().recs.length).toBe(HELD_RECORDS)
    c.receive(realMsg({ k: 'rec', rec: rs }), 'hello')
    expect(c.held().recs.length).toBe(HELD_RECORDS)
    c.receive(realMsg({ k: 'rec', rec: r1 }), 'hello')
    expect([c.chain()!.top, c.trusted(), c.held().recs.length]).toEqual([
      2,
      [dkOf('D3')],
      HELD_RECORDS,
    ])
  })

  test('a held move keeps at most HELD_RECORDS of the chain it carries, so it is still held after a reload', () => {
    const long = Array.from({ length: 3 * HELD_RECORDS }, (_, i): Rec => ({
      ik: 'V',
      n: 1,
      prev: `cY${i}`,
      by: 'rkX',
      pk: `pY${i}`,
      keep: [],
    }))
    const u = carried()
    u.receive(realMsg(move(recD(r1), 'rkV', W, [r1, ...long])), 'card')
    expect(u.heldSucc.map(x => x.chain.length)).toEqual([HELD_RECORDS])
    expect(u.heldSucc[0].chain[0]).toEqual(record(r1))
    const back = ContactClaims.parse(JSON.parse(JSON.stringify(u)))!
    expect(JSON.stringify(back)).toBe(JSON.stringify(u))
    u.receive(realMsg({ k: 'cr', cr: crV }), 'hello')
    expect(u.accept({ kind: 'cr', id: crId })).toBe(true)
    expect(u.claims()).toMatchObject([{ kind: 'succ', new: ikOf('W'), v: 2 }])
  })
})

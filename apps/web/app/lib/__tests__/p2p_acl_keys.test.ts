import { describe, expect, test } from 'bun:test'
import { execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { sha256 } from '@noble/hashes/sha2.js'
import { utf8 } from '../p2p/canonical'
import {
  headOf,
  makeCreation,
  makeRecovery,
  makeRemoval,
  makeReset,
  recordId,
  type ChainRecord,
  type CreationRecord,
} from '../p2p/chain'
import { keyId, publicOf, type KeyPair } from '../p2p/keys'
import {
  carriedOf,
  creationOf,
  droppedBy,
  protection,
  signerOf,
  stateOf,
  voidDevice,
  type KeyEv,
  type KeysCtx,
} from '../p2p/acl/keys'

// The protection state in production (`acl/keys.ts`) against the model's `resolveProtection` and the
// second reference `protectionOracle`, function by function, on the model's own worlds: the seven
// recovery-key templates, the model's rules-3 vectors, and the stolen later-epoch device cases. Everything that builds a
// model world runs in a process of its own, because test files share their modules: the model's
// vector files check every world built in their process, and the model reads its mutant when it
// loads. Below them, the rules-3 fields read without the model.
// ACL_KEYS_SEEDS scales the template runs and ACL_SEED_FROM moves their range.

const SEEDS = Number(process.env.ACL_KEYS_SEEDS ?? 2000)
const FROM = Number(process.env.ACL_SEED_FROM ?? 1)
const HERE = fileURLToPath(new URL('.', import.meta.url))
const exec = promisify(execFile)
const TEMPLATES = [
  'rk-thief',
  'rk-newsrv',
  'rk-leak',
  'rk-legacy',
  'rk-rejoin',
  'rk-upgrade',
  'rk-left',
]

// `bun p2p_acl_rules3.ts <template> <from> <n>`: the differences on those seeds, and the templates the
// model has.
const sweep = async (template: string, from: number, n: number, mutant = '') => {
  const { stdout } = await exec(
    process.execPath,
    [`${HERE}p2p_acl_rules3.ts`, template, String(from), String(n)],
    { env: { ...process.env, ACL_MUT: mutant }, maxBuffer: 1 << 24 }
  )
  return JSON.parse(stdout.trim()) as { differences: string[]; templates: string[] }
}

// A file of model tests, run alone: what bun says at the end, and the tests that failed.
const run = async (file: string) => {
  const out = await exec(process.execPath, ['test', `./${file}`], {
    cwd: HERE,
    maxBuffer: 1 << 26,
  }).catch((e: { stdout: string; stderr: string }) => e)
  const text = `${out.stdout}\n${out.stderr}`
  const count = (what: string) => Number(new RegExp(`^\\s*(\\d+) ${what}$`, 'm').exec(text)?.[1])
  return {
    pass: count('pass'),
    fail: count('fail'),
    failed: text.split('\n').filter(l => l.startsWith('(fail)') || l.startsWith('error:')),
    text,
  }
}

describe('the recovery-key templates: production equals the model and the oracle', () => {
  let all: Map<string, ReturnType<typeof sweep>> | undefined
  const started = () =>
    (all ??= new Map(TEMPLATES.map(template => [template, sweep(template, FROM, SEEDS)])))

  for (const template of TEMPLATES)
    test(`${template} seeds ${FROM} to ${FROM + SEEDS - 1}`, async () => {
      const got = await started().get(template)!
      expect(got.differences).toEqual([])
      expect(got.templates).toEqual(TEMPLATES)
    }, 3_600_000)
})

test("the model's rules-3 vectors, under their own names: production equals the model and the oracle on every world they build", async () => {
  const got = await run('p2p_acl_keys_vectors.ts')
  expect(got.failed).toEqual([])
  expect([got.pass, got.fail]).toEqual([118, 0])
  expect(/worlds compared: (\d+) \((\d+) on rules 3\)/.exec(got.text)?.slice(1)).toEqual([
    '174',
    '156',
  ])
}, 1_200_000)

test('a stolen later-epoch device undoes no transfer (the saved seed 93,100,183; 0 in 1,000 shapes)', async () => {
  const got = await run('p2p_acl_keys_attacks.ts')
  expect(got.failed).toEqual([])
  expect([got.pass, got.fail]).toEqual([16, 0])
}, 1_200_000)

// ----- The model's mutants -----

const MUTANTS: [string, string][] = [
  ['rk-upg-any-carrier', 'rk-upgrade'],
  ['rk-upg-intro-any', 'rk-upgrade'],
  ['rk-sigchain-off', 'rk-upgrade'],
  ['rk-key-alive', 'rk-leak'],
  ['rk-epoch-alive', 'rk-thief'],
  ['rk-branch-alive', 'rk-leak'],
  ['rk-rival-ok', 'rk-leak'],
  ['rk-void-off', 'rk-legacy'],
  ['rk-sh-off', 'rk-thief'],
  ['rk-reset-pk', 'rk-leak'],
]

test('each mutant of these rules, applied to the model, makes the comparison fail', async () => {
  const differs = async (mutant: string, template: string) =>
    [mutant, (await sweep(template, 1, 60, mutant)).differences.length > 0] as const
  const templates = [...new Set(MUTANTS.map(([, tpl]) => tpl))]
  const clean = await Promise.all(templates.map(tpl => differs('', tpl)))
  expect(clean.map(([, d]) => d)).toEqual(templates.map(() => false))
  const got = await Promise.all(MUTANTS.map(([m, tpl]) => differs(m, tpl)))
  expect(got).toEqual(MUTANTS.map(([m]) => [m, true] as const))
}, 1_800_000)

// ----- The wire fields, read without the model -----

const AT = 1_762_400_000_000
const pairs = new Map<string, KeyPair>()
const K = (name: string): KeyPair => {
  let k = pairs.get(name)
  if (!k) {
    const sk = sha256(utf8(`rchat-p2p-keys-test ${name}`))
    k = { sk, pk: publicOf(sk) }
    pairs.set(name, k)
  }
  return k
}
const id = (name: string) => keyId(K(name).pk)

interface Built {
  cx: KeysCtx
  ids: string[]
  add(id: string, t: string, a: string, dev: string, c: Record<string, unknown>, ap: string[]): void
}

const build = (): Built => {
  const evs = new Map<string, KeyEv>()
  const anc = new Map<string, Set<string>>()
  const ids: string[] = []
  return {
    ids,
    cx: {
      ev: x => evs.get(x)!,
      anc: x => anc.get(x)!,
      intro: x => ['genesis', 'device_add', 'primary_rotate', 'join'].includes(evs.get(x)!.t),
    },
    add(x, tt, a, dev, c, ap) {
      evs.set(x, { id: x, t: tt, a, dev, c })
      const past = new Set<string>()
      for (const p of ap) {
        past.add(p)
        for (const q of anc.get(p)!) past.add(q)
      }
      anc.set(x, past)
      ids.push(x)
    },
  }
}

describe('the rules-3 fields', () => {
  const O = id('O')
  const V = id('V')
  const cr = makeCreation(K('V'), K('rkV'), id('p0'), AT)
  const r1 = makeRecovery(V, K('rkV'), headOf(cr), id('p1'), [id('V2')], AT)
  const genesis = (b: Built, c: Record<string, unknown> = { rules: 3 }) =>
    b.add('g', 'genesis', O, id('O1'), { ...c, owners: [{ ik: O, dk: id('O1'), dcert: '' }] }, [])
  const join = (b: Built, idb: Record<string, unknown>, x = 'j', dev = 'V1', ap = ['g']) =>
    b.add(x, 'join', V, id(dev), { idb: { ik: V, dcert: '', ...idb } }, ap)

  test('a rules-2 server has no protection state, whatever its events carry', () => {
    for (const c of [{ rules: 2 }, {}]) {
      const b = build()
      genesis(b, c)
      join(b, { cr, by: id('p0') })
      const P = protection(b.ids, b.cx)
      expect(P.ids.size).toBe(0)
      expect(P.inert.size).toBe(0)
      expect(stateOf(P, V)).toBe('none')
    }
  })

  test("a join's idb carries the creation record and names the head's primary", () => {
    const b = build()
    genesis(b)
    join(b, { cr, by: id('p0') })
    const P = protection(b.ids, b.cx)
    expect(stateOf(P, V)).toBe('protected')
    expect(stateOf(P, O)).toBe('none')
    expect(P.ids.get(V)).toEqual({
      st: 'protected',
      rec: [id('rkV')],
      prim: [id('p0')],
      crs: [recordId(cr)],
      cr,
      chain: [],
      heads: [headOf(cr)],
    })
    expect(P.records.get('j')).toEqual({ by: id('p0'), rk: false, head: headOf(cr) })
    expect(P.inert.size).toBe(0)
    expect(creationOf(b.cx.ev('j'))).toEqual(cr)
    expect(signerOf(b.cx.ev('j'))).toBe(id('p0'))
  })

  test('an absent by means the identity key, which voids the creation record', () => {
    const b = build()
    genesis(b)
    join(b, { cr })
    expect(signerOf(b.cx.ev('j'))).toBe(V)
    const P = protection(b.ids, b.cx)
    expect(P.ids.get(V)).toEqual({
      st: 'void',
      why: 'ik',
      rec: [V],
      prim: [V],
      crs: [recordId(cr)],
      chain: [],
      heads: [],
    })
    expect(P.inert.size).toBe(0)
    b.add('a', 'device_add', V, id('V2'), { dcert: '', by: id('p0') }, ['j'])
    expect([...protection(b.ids, b.cx).inert]).toEqual(['a'])
  })

  test('a second creation record for the identity voids it', () => {
    const b = build()
    genesis(b)
    join(b, { cr, by: id('p0') })
    const other = makeCreation(K('V'), K('rkZ'), id('pZ'), AT)
    join(b, { cr: other, by: id('pZ') }, 'j2', 'V9')
    const P = protection(b.ids, b.cx)
    expect(P.ids.get(V)?.st).toBe('void')
    expect(P.ids.get(V)?.why).toBe('cr')
    expect(P.ids.get(V)?.crs).toEqual([recordId(cr), recordId(other)].sort())
    expect([...P.inert].sort()).toEqual(['j', 'j2'])
  })

  test('a copy of the creation record that differs only in its signatures is the same record', () => {
    const b = build()
    genesis(b)
    join(b, { cr, by: id('p0') })
    const again = { ...makeCreation(K('V'), K('rkV'), id('p0'), AT) }
    join(b, { cr: again, by: id('p0') }, 'j2', 'V9')
    expect(protection(b.ids, b.cx).ids.get(V)?.st).toBe('protected')
  })

  test('a creation record with an unknown field, for another identity or with a bad signature is not read', () => {
    for (const bad of [
      { ...cr, note: 1 },
      makeCreation(K('W'), K('rkV'), id('p0'), AT),
      { ...cr, sig_rk: cr.sig_ik },
    ] as unknown as CreationRecord[]) {
      const b = build()
      genesis(b)
      join(b, { cr: bad, by: id('p0') })
      expect(protection(b.ids, b.cx).ids.size).toBe(0)
      expect(creationOf(b.cx.ev('j'))).toBeUndefined()
    }
  })

  test('a rotation carries the records its position lacks, and a later certificate is signed by the new primary', () => {
    const b = build()
    genesis(b)
    join(b, { cr, by: id('p0') })
    b.add('a0', 'device_add', V, id('V3'), { dcert: '', by: id('p0') }, ['j'])
    const rotate = {
      ik: V,
      pcert: id('p1'),
      keep: [],
      seen: {},
      rsig: '',
      chain: [r1],
      by: id('rkV'),
    }
    b.add('r', 'primary_rotate', V, id('V2'), rotate, ['j'])
    b.add('a1', 'device_add', V, id('V4'), { dcert: '', by: id('p1') }, ['r'])
    const P = protection(b.ids, b.cx)
    expect(P.ids.get(V)?.heads).toEqual([headOf(r1)])
    expect(P.ids.get(V)?.prim).toEqual([id('p1')])
    expect(P.records.get('r')).toEqual({
      by: id('rkV'),
      rk: true,
      head: headOf(r1),
      head1: { d: headOf(r1).d, keep: [id('V2')] },
    })
    expect(P.records.get('a1')).toEqual({ by: id('p1'), rk: false, head: headOf(r1) })
    expect(P.records.get('a0')).toEqual({ by: id('p0'), rk: false, head: headOf(cr) })
    expect([...P.inert]).toEqual(['a0'])
    expect([...P.lineage]).toEqual(['r'])
    expect(carriedOf(b.cx.ev('r'))).toEqual([r1])
    expect(droppedBy(b.cx.ev('r'), b.ids, b.cx, P, 8).sort()).toEqual([id('V1'), id('V3')].sort())
    expect(voidDevice(P.inert, b.cx, b.ids, V, id('V3'))).toBe(true)
    expect(voidDevice(P.inert, b.cx, b.ids, V, id('V1'))).toBe(false)
    expect(voidDevice(P.inert, b.cx, b.ids, V, id('V8'))).toBe(false)
  })

  test('a copy of a chain record with a bad signature is no record and makes its event no carrier', () => {
    const forged = { ...r1, sig: makeRecovery(V, K('thief'), headOf(cr), id('p1'), [], AT).sig }
    expect(recordId(forged)).toBe(recordId(r1))
    const rotate = (chain: ChainRecord[], by: string) => ({
      ik: V,
      pcert: id('p1'),
      keep: [],
      seen: {},
      rsig: '',
      chain,
      by,
    })
    const b = build()
    genesis(b)
    join(b, { cr, by: id('p0') })
    b.add('a0', 'device_add', V, id('V3'), { dcert: '', by: id('p0') }, ['j'])
    b.add('f', 'primary_rotate', V, id('V2'), rotate([forged], id('rkV')), ['j'])
    let P = protection(b.ids, b.cx)
    expect(P.ids.get(V)?.heads).toEqual([headOf(cr)])
    expect(P.inert.has('a0')).toBe(false)
    b.add('r', 'primary_rotate', V, id('V2'), rotate([r1], id('rkV')), ['a0', 'f'])
    P = protection(b.ids, b.cx)
    expect(P.ids.get(V)?.heads).toEqual([headOf(r1)])
    expect(P.inert.has('a0')).toBe(false)
    expect(P.records.get('f')?.head).toEqual(headOf(cr))
  })

  test('rival resets freeze the identity, and name the carriers of both', () => {
    const mine = makeReset(V, K('rkV'), K('rkV2'), headOf(cr), id('p1'), [id('V2')], AT)
    const theirs = makeReset(V, K('rkV'), K('rkZ'), headOf(cr), id('pZ'), [id('V9')], AT)
    const rotate = (r: ChainRecord, by: string) => ({
      ik: V,
      pcert: r.pk,
      keep: [],
      seen: {},
      rsig: '',
      chain: [r],
      by,
    })
    const b = build()
    genesis(b)
    join(b, { cr, by: id('p0') })
    b.add('r', 'primary_rotate', V, id('V2'), rotate(mine, id('rkV2')), ['j'])
    b.add('z', 'primary_rotate', V, id('V9'), rotate(theirs, id('rkZ')), ['j'])
    const P = protection(b.ids, b.cx)
    expect(stateOf(P, V)).toBe('frozen')
    expect(P.frozen.get(V)).toEqual(['r', 'z'])
    expect([...P.rivalCarriers].sort()).toEqual(['r', 'z'])
    expect([...P.inert].sort()).toEqual(['r', 'z'])
    expect(P.ids.get(V)?.rec).toEqual([])
    expect(P.ids.get(V)?.heads).toEqual([])
  })

  test("an upgrade's signatures: a bare string is signed by the identity key, an entry names its key and may carry the chain", () => {
    const crO = makeCreation(K('O'), K('rkO'), id('pO'), AT)
    const rO = makeRecovery(O, K('rkO'), headOf(crO), id('pO1'), [id('O1')], AT)
    const start = () => {
      const b = build()
      b.add(
        'g',
        'genesis',
        O,
        id('O1'),
        { rules: 3, owners: [{ ik: O, dk: id('O1'), dcert: '', cr: crO, by: id('pO') }] },
        []
      )
      return b
    }
    let b = start()
    b.add('u', 'upgrade', O, id('O1'), { g: {}, sigs: { [O]: { by: id('pO'), sig: '' } } }, ['g'])
    let P = protection(b.ids, b.cx)
    expect(stateOf(P, O)).toBe('protected')
    expect(P.records.get(`u ${O}`)).toEqual({ by: id('pO'), rk: false, head: headOf(crO) })
    expect(P.inertUpgrades.size).toBe(0)

    b = start()
    b.add('u', 'upgrade', O, id('O1'), { g: {}, sigs: { [O]: 'sig' } }, ['g'])
    P = protection(b.ids, b.cx)
    expect(P.ids.get(O)?.why).toBe('ik')

    b = start()
    const sigs = { [O]: { by: id('pO1'), sig: '', chain: [rO] } }
    b.add('u', 'upgrade', O, id('O1'), { g: {}, sigs }, ['g'])
    P = protection(b.ids, b.cx)
    expect(P.ids.get(O)?.heads).toEqual([headOf(rO)])
    expect(P.records.get(`u ${O}`)).toEqual({ by: id('pO1'), rk: false, head: headOf(rO) })
    expect(P.inertUpgrades.size).toBe(0)

    b = start()
    b.add('u', 'upgrade', O, id('O1'), { g: {}, sigs: { [O]: { by: id('pZ'), sig: '' } } }, ['g'])
    P = protection(b.ids, b.cx)
    expect([...P.inertUpgrades]).toEqual(['u'])
    expect(P.records.get(`u ${O}`)).toEqual({ by: id('pZ'), rk: false })
  })

  test('an upgrade dies only through a rotation signed by a recovery key, not through a join that carries the record', () => {
    const crO = makeCreation(K('O'), K('rkO'), id('pO'), AT)
    const removal = makeRemoval(O, K('rkO'), headOf(crO), id('pX'), [id('O2')], AT)
    const start = () => {
      const b = build()
      b.add(
        'g',
        'genesis',
        O,
        id('O1'),
        { rules: 3, owners: [{ ik: O, dk: id('O1'), dcert: '', cr: crO, by: id('pO') }] },
        []
      )
      b.add('u', 'upgrade', O, id('O1'), { g: {}, sigs: { [O]: { by: id('pO'), sig: '' } } }, ['g'])
      return b
    }
    let b = start()
    const idb = { ik: O, dcert: '', cr: crO, chain: [removal], by: id('pX') }
    b.add('j', 'join', O, id('O2'), { idb }, ['g'])
    let P = protection(b.ids, b.cx)
    expect(P.ids.get(O)?.rec).toEqual([id('pX')])
    expect(P.records.get('j')).toEqual({ by: id('pX'), rk: false, head: headOf(removal) })
    expect([...P.inertUpgrades]).toEqual([])
    expect([...P.inert]).toEqual([])

    b = start()
    const rotate = { ik: O, pcert: id('pX'), keep: [], seen: {}, rsig: '', chain: [removal] }
    b.add('r', 'primary_rotate', O, id('O2'), { ...rotate, by: id('pX') }, ['g'])
    P = protection(b.ids, b.cx)
    expect(P.records.get('r')).toEqual({
      by: id('pX'),
      rk: true,
      head: headOf(removal),
      head1: { d: headOf(removal).d, keep: [id('O2')] },
    })
    expect([...P.inertUpgrades]).toEqual(['u'])
  })

  test('fields of other types are ignored without a throw', () => {
    const b = build()
    b.add('g', 'genesis', O, id('O1'), { rules: 3, owners: [null, 'x', { ik: 5 }, { ik: O }] }, [])
    b.add('j', 'join', V, id('V1'), { idb: 'x' }, ['g'])
    b.add('j2', 'join', V, id('V1'), { idb: { cr, chain: 'x', by: 5 } }, ['g'])
    b.add('r', 'primary_rotate', V, id('V1'), { chain: [null, 5, { n: 1 }], keep: 'x' }, ['j2'])
    b.add('u', 'upgrade', O, id('O1'), { sigs: { [V]: 5, [O]: null } }, ['g'])
    b.add('u2', 'upgrade', O, id('O1'), { sigs: 'x' }, ['g'])
    const P = protection(b.ids, b.cx)
    expect(P.ids.get(V)?.st).toBe('void')
    expect(P.ids.get(O)).toBeUndefined()
  })
})

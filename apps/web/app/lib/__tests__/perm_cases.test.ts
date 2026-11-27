import { afterAll, describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  atLeast,
  bit,
  channelMask,
  checkBitsEdit,
  checkOverwriteEdit,
  fromWire,
  hasBit,
  known,
  maskAnd,
  maskNot,
  maskOr,
  mayAssign,
  moved,
  outranks,
  ready,
  registry,
  reorder,
  serverBits,
  toWire,
  unload,
  widens,
  type Actor,
  type Bit,
  type Ow,
  type PermsModule,
  type Rank,
} from '../perms'
import { ALL_PERMS, Perm } from '../types'
import { authCore, channelPerms, P, type ChanFacts } from '../p2p/acl/rules'
import { jsBuild, loadPerms, wasmBuild } from './helpers/perms'
import { authCase, worldLines, type AuthWorlds } from './helpers/perm_auth_cases'

const ASSETS = join(
  fileURLToPath(new URL('.', import.meta.url)),
  '..',
  '..',
  '..',
  '..',
  '..',
  'assets'
)
const json = <T>(name: string) => JSON.parse(readFileSync(join(ASSETS, name), 'utf8')) as T

interface Cases {
  p2p4: {
    channel_bits: { bit: number; out: string }[]
    channel_worlds: string[]
    auth_ranks: string[]
    auth_lists: string[]
    auth_worlds: AuthWorlds[]
    auth_cases: string[]
    voice_worlds: { bits: number[]; out: string }
  }
}
const cases = json<Cases>('perm_cases.json')

interface World {
  owner: boolean
  everyone: number
  roles: [number, number]
  holds: number
  rows: [Row, Row, Row, Row]
  restrict: number
}
type Row = [number, number] | undefined

const heldOf = (w: World) => w.roles.slice(0, w.holds).reduce((m, b) => m | b, 0)

// The member's mask in the channel.
const maskOf = (w: World, rules: number, voice = false) => {
  const ow = (row: Row): Ow | undefined =>
    row && { allow: fromWire(row[0], rules), deny: fromWire(row[1], rules) }
  return channelMask(
    w.owner ? { kind: 'owner' } : { kind: 'member', roles: fromWire(heldOf(w), rules) },
    fromWire(w.everyone, rules),
    {
      everyone: ow(w.rows[0]),
      restrictView: (w.restrict & 1) !== 0,
      restrictSend: (w.restrict & 2) !== 0,
      voice,
      roles: w.rows.slice(1, 1 + w.holds).flatMap(r => ow(r) ?? []),
      member: ow(w.rows[3]),
    },
    rules
  )
}

// The wire mask of the member, or null for every bit.
const run = (w: World, rules: number): number | null => {
  const mask = maskOf(w, rules)
  const manages = w.owner || ((w.everyone | heldOf(w)) & P.ManageChannels) !== 0
  return manages && mask === known(rules) ? null : toWire(mask, rules)
}

// The same world as P2P facts, for `channelPerms`: the member is 'p', the channel 'v'.
const factsOf = (w: World): ChanFacts => {
  const names = ['r:everyone', 'r:r1', 'r:r2', 'u:p']
  const ov = new Map(
    w.rows.flatMap((r, i) => (r ? [[names[i], { allow: r[0], deny: r[1] }] as const] : []))
  )
  return {
    owners: new Set(w.owner ? ['p'] : []),
    bits: new Map([
      ['everyone', w.everyone],
      ['r1', w.roles[0]],
      ['r2', w.roles[1]],
    ]),
    holds: new Map([['p', new Set(['r1', 'r2'].slice(0, w.holds))]]),
    overwrites: new Map([['v', ov]]),
    channels: new Map([
      [
        'v',
        {
          kind: 'voice',
          restrict_view: (w.restrict & 1) !== 0,
          restrict_send: (w.restrict & 2) !== 0,
        },
      ],
    ]),
  } as unknown as ChanFacts
}

const tri = (k: number, b: number): Row => (k === 0 ? undefined : k === 1 ? [b, 0] : [0, b])

afterAll(() => loadPerms())

const builds: [string, () => Promise<PermsModule>][] = [
  ['WebAssembly', wasmBuild],
  ['JavaScript', jsBuild],
]

for (const [name, build] of builds)
  describe(`the permission rules through the ${name} build`, () => {
    const load = () => loadPerms(build)

    test('single-bit channel worlds match the recorded outputs', async () => {
      await load()
      for (const rules of [2, 4])
        for (const { bit: b, out } of cases.p2p4.channel_bits) {
          let got = ''
          for (let i = 0; i < 2 * 2 * 3 * 81 * 4; i++) {
            const digit = (div: number, radix: number) => Math.floor(i / div) % radix
            const m = run(
              {
                owner: false,
                everyone: digit(1944, 2) * b,
                roles: [digit(972, 2) * b, 0],
                holds: digit(324, 3),
                rows: [
                  tri(digit(108, 3), b),
                  tri(digit(36, 3), b),
                  tri(digit(12, 3), b),
                  tri(digit(4, 3), b),
                ],
                restrict: digit(1, 4),
              },
              rules
            )
            got += m === null ? 'A' : (m & b) !== 0 ? '1' : '0'
          }
          expect(got === out).toBe(true)
        }
    })

    test('random channel worlds match the recorded outputs', async () => {
      await load()
      for (const rules of [2, 4])
        for (const line of cases.p2p4.channel_worlds) {
          const n = line.split(' ').map(Number)
          const row = (k: number): Row =>
            n[5 + 2 * k] === -1 ? undefined : [n[5 + 2 * k], n[6 + 2 * k]]
          const got = run(
            {
              owner: n[0] === 1,
              everyone: n[1],
              roles: [n[2], n[3]],
              holds: n[4],
              rows: [row(0), row(1), row(2), row(3)],
              restrict: n[13],
            },
            rules
          )
          expect([line, got]).toEqual([line, n[14] === -1 ? null : n[14]])
        }
    })

    test('voice follows View as recorded, in the mask and in what channel views carry', async () => {
      await load()
      const { bits, out } = cases.p2p4.voice_worlds
      const voice = maskOr(maskOr(bit('Connect'), bit('Speak')), bit('Video'))
      const subset = (k: number) => bits.reduce((m, b, i) => ((k >> i) & 1 ? m | b : m), 0)
      const said = (m: number) => {
        const v = maskAnd(m, voice)
        return v === 0 ? '0' : v === voice ? '1' : '?'
      }
      for (const rules of [2, 4]) {
        let mask = ''
        let view = ''
        for (let i = 0; i < 2 * 8 * 8 * 2 * 27 * 4; i++) {
          const digit = (div: number, radix: number) => Math.floor(i / div) % radix
          const w: World = {
            owner: digit(13824, 2) === 1,
            everyone: subset(digit(1728, 8)),
            roles: [subset(digit(216, 8)), 0],
            holds: digit(108, 2),
            rows: [
              tri(digit(36, 3), P.ViewChannel),
              tri(digit(12, 3), P.ViewChannel),
              undefined,
              tri(digit(4, 3), P.ViewChannel),
            ],
            restrict: digit(1, 4),
          }
          mask += said(maskOf(w, rules, true))
          view += said(fromWire(channelPerms(factsOf(w), 'p', 'v', rules), rules))
        }
        expect([rules, mask === out, view === out]).toEqual([rules, true, true])
      }
    })

    test('small authority worlds match the recorded outputs', async () => {
      await load()
      const { auth_ranks: ranks, auth_lists: lists, auth_worlds: worlds } = cases.p2p4
      for (const rules of [2, 4])
        for (const w of worlds) {
          let got = ''
          for (const line of worldLines(w, ranks, lists)) {
            const { e, x } = authCase(`${line} 0`)
            got += authCore(e, x, rules) ? '1' : '0'
          }
          expect([w.t, got === w.out]).toEqual([w.t, true])
        }
    })

    test('recorded authority decisions match', async () => {
      await load()
      for (const rules of [2, 4]) {
        const wrong = cases.p2p4.auth_cases.filter(line => {
          const { e, x, want } = authCase(line)
          return authCore(e, x, rules) !== want
        })
        expect(wrong).toEqual([])
      }
    })

    test('the registry is the fixture, and the TypeScript bit tables follow it', async () => {
      await load()
      expect(registry()).toEqual(json<Bit[]>('perm_bits.json'))
      for (const [name, value] of Object.entries(Perm))
        expect([name, bit(name)]).toEqual([name, value])
      for (const name of Object.keys(Perm))
        expect([name, registry().find(b => b.name === name)?.hosted]).toEqual([name, 'live'])
      expect(Object.values(Perm).reduce((m, b) => maskOr(m, b), 0)).toBe(ALL_PERMS)
      const ungated = new Set(['PinMessages', 'BypassSlowmode'])
      const gated = registry()
        .filter(b => b.hosted === 'live' && !b.everyone && !ungated.has(b.name))
        .reduce((m, b) => maskOr(m, b.value), 0)
      expect(gated).toBe(ALL_PERMS)
      const wire = new Map(registry().flatMap(b => (b.p2p ? [[b.name, b.p2p] as const] : [])))
      const names: Record<keyof typeof P, string> = {
        ManageChannels: 'ManageChannels',
        ManageMessages: 'DeleteMessages',
        Kick: 'Kick',
        ManageServer: 'ManageServer',
        ManageRoles: 'ManageRoles',
        Ban: 'BanMembers',
        Invite: 'CreateInvites',
        MentionEveryone: 'MentionEveryone',
        ViewChannel: 'ViewChannels',
        SendMessages: 'SendMessages',
        TimeoutMembers: 'TimeoutMembers',
      }
      const since = (name: string) => (name === 'TimeoutMembers' ? 5 : 2)
      for (const [name, value] of Object.entries(P))
        expect([name, wire.get(names[name as keyof typeof P])]).toEqual([
          name,
          { value, state: 'live', since: since(name) },
        ])
      expect(toWire(known(4), 4)).toBe(
        Object.entries(P).reduce((m, [name, b]) => (since(name) <= 4 ? m | b : m), 0)
      )
      expect(toWire(0, 4, 1 << 20)).toBe(1 << 20)
    })

    test('ranks, edits, order and sync answer', async () => {
      await load()
      expect(outranks({ tier: 'owner' }, { tier: 'role', pos: 9, tie: 'r' })).toBe(true)
      expect(outranks({ tier: 'owner' }, { tier: 'owner' })).toBe(false)
      expect(atLeast({ tier: 'owner' }, { tier: 'owner' })).toBe(true)
      expect(outranks({ tier: 'role', pos: 1, tie: 'b' }, { tier: 'role', pos: 1, tie: 'a' })).toBe(
        true
      )
      expect(outranks({ tier: 'role', pos: 1, tie: -3 }, { tier: 'role', pos: 1, tie: -7 })).toBe(
        true
      )
      expect(outranks({ tier: 'plain' }, { tier: 'role', pos: -2, tie: 'a' })).toBe(true)
      expect(outranks({ tier: 'plain' }, { tier: 'outside' })).toBe(true)
      const view = bit('ViewChannels')
      const send = bit('SendMessages')
      const kick = bit('Kick')
      expect(serverBits({ kind: 'admin', mask: kick, roles: 2 + view }, 0, 0)).toBe(kick + view)
      const manager: Actor = {
        rank: { tier: 'role', pos: 3, tie: 1 },
        bits: bit('ManageRoles') + kick,
      }
      const mid: Rank = { tier: 'role', pos: 2, tie: 1 }
      expect(mayAssign(manager, mid, kick, true, undefined, 0)).toBe(true)
      expect(mayAssign(manager, mid, kick, true, undefined, 0, false)).toBe(false)
      expect(mayAssign(manager, mid, kick, true, undefined, 0, true)).toBe(true)
      expect(checkOverwriteEdit(view, false, undefined, { allow: view, deny: 0 }, true)).toBe(null)
      expect(checkOverwriteEdit(view, false, undefined, { allow: send, deny: 0 }, true)).toBe(
        'grants'
      )
      expect(checkOverwriteEdit(0, false, undefined, { allow: 0, deny: 2 }, true)).toBe(
        'denies_moderation'
      )
      expect(checkOverwriteEdit(2, false, undefined, { allow: 0, deny: 2 }, false)).toBe(
        'outranked'
      )
      expect(checkBitsEdit(4, false, 0, 5)).toBe('grants')
      expect(checkBitsEdit(4, true, 0, 5)).toBe(null)
      expect(reorder([1, 2, 3, 4], [4, 1, 3, 2], [2, 3, 4])).toEqual([1, 4, 3, 2])
      expect(moved([1, 2, 3, 4], [4, 1, 2, 3])).toEqual([4])
      expect(
        widens(
          [['r:1', view]],
          [
            ['r:1', view + send],
            ['u:a', view],
          ]
        )
      ).toEqual(['r:1', 'u:a'])
      expect(widens([], [])).toEqual([])
    })
  })

describe('masks above 32 bits', () => {
  test('the helpers are exact up to 2^53', () => {
    const a = 2 ** 34 + 2 ** 31 + 5
    const b = 2 ** 52 + 2 ** 34 + 4
    expect(maskAnd(a, b)).toBe(2 ** 34 + 4)
    expect(maskOr(a, b)).toBe(2 ** 52 + 2 ** 34 + 2 ** 31 + 5)
    expect(maskNot(0)).toBe(2 ** 53 - 1)
    expect(maskAnd(maskNot(a), a)).toBe(0)
    expect(maskOr(maskNot(a), a)).toBe(2 ** 53 - 1)
    expect(hasBit(a, 2 ** 31)).toBe(true)
    expect(hasBit(a, 2 ** 32)).toBe(false)
  })
})

describe('loading the rules', () => {
  test('a decision before the load throws, and a failed load can be tried again', async () => {
    unload()
    expect(() => known(0)).toThrow('permission rules are not loaded')
    let failure: unknown = null
    await ready(() => Promise.reject(new Error('no module'))).catch((e: unknown) => {
      failure = e
    })
    expect(failure instanceof Error).toBe(true)
    await ready(wasmBuild)
    expect(known(4)).toBeGreaterThan(0)
  })
})

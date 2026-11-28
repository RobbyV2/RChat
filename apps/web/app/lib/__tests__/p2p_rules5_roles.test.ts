import { describe, expect, test } from 'bun:test'
import {
  authCore,
  P,
  RULES_NEXT,
  RULES_VERSION,
  simpleCtx,
  type AclContent,
  type AclEv,
  type ChanFacts,
} from '../p2p/acl/rules'
import type { FactsQ } from '../p2p/acl/facts'
import { bit, toWire } from '../perms'

// A room with an owner 'o', 'm' holding role 'mgr' (position 5), 'd' holding role 'mod'
// (position 3) and 'p' holding role 'low' (position 1); role 'top' sits at position 9.
const wire = (...names: string[]) =>
  toWire(
    names.map(bit).reduce((a, b) => a + b, 0n),
    RULES_NEXT
  )
const ASSIGN = wire('AssignRoles')
const room = (
  rules: number,
  mgr: number,
  low = 0,
  rows: Record<string, { allow?: number; deny?: number }> = {},
  channel: Record<string, unknown> = { kind: 'text' }
) =>
  ({
    rules,
    owners: new Set(['o']),
    mem: new Set(['o', 'm', 'd', 'p']),
    roles: new Set(['top', 'mgr', 'mod', 'low']),
    bits: new Map([
      ['everyone', wire('ViewChannels', 'SendMessages')],
      ['top', 0],
      ['mgr', mgr],
      ['mod', P.Kick],
      ['low', low],
    ]),
    holds: new Map([
      ['m', new Set(['mgr'])],
      ['d', new Set(['mod'])],
      ['p', new Set(['low'])],
    ]),
    pos: new Map([
      ['top', 9],
      ['mgr', 5],
      ['mod', 3],
      ['low', 1],
    ]),
    overwrites: new Map([['c', new Map(Object.entries(rows))]]),
    channels: new Map([['c', channel]]),
  }) as unknown as FactsQ & ChanFacts
const ev = (t: string, a: string, c: Record<string, unknown>): AclEv =>
  ({ id: 'e', t, a, dev: 'd', c: c as unknown as AclContent }) as unknown as AclEv
const decide = (F: FactsQ & ChanFacts, e: AclEv) => authCore(e, simpleCtx(F, e.a))
const assign = (a: string, to: string, role: string) => ev('assign', a, { to, role })
const revoke = (a: string, to: string, role: string) => ev('revoke', a, { to, role })

describe('roles under rules 5', () => {
  test('giving a role needs Assign roles, where rules 4 take Manage roles', () => {
    expect(decide(room(RULES_VERSION, P.ManageRoles), assign('m', 'p', 'mod'))).toBe(true)
    expect(decide(room(RULES_NEXT, P.ManageRoles), assign('m', 'p', 'low'))).toBe(false)
    expect(decide(room(RULES_NEXT, ASSIGN), assign('m', 'p', 'low'))).toBe(true)
    expect(decide(room(RULES_NEXT, ASSIGN), revoke('m', 'p', 'low'))).toBe(true)
    expect(decide(room(RULES_NEXT, P.ManageRoles), revoke('m', 'p', 'low'))).toBe(false)
    expect(decide(room(RULES_NEXT, P.ManageRoles), revoke('p', 'p', 'low'))).toBe(true)
  })

  test('the role and the member have to rank below the author', () => {
    const F = room(RULES_NEXT, ASSIGN | P.Kick)
    expect(decide(F, assign('m', 'p', 'top'))).toBe(false)
    expect(decide(F, assign('m', 'p', 'mgr'))).toBe(false)
    expect(decide(F, assign('d', 'p', 'low'))).toBe(false)
    expect(decide(F, assign('m', 'o', 'low'))).toBe(false)
    expect(decide(F, assign('o', 'm', 'top'))).toBe(true)
    expect(decide(F, revoke('m', 'd', 'mod'))).toBe(true)
    expect(decide(F, revoke('d', 'm', 'mgr'))).toBe(false)
  })

  test("a role's permissions have to be within the author's", () => {
    const kicker = room(RULES_NEXT, ASSIGN | P.Kick)
    expect(decide(kicker, assign('m', 'p', 'mod'))).toBe(true)
    expect(decide(room(RULES_NEXT, ASSIGN), assign('m', 'p', 'mod'))).toBe(false)
    expect(decide(room(RULES_VERSION, P.ManageRoles), assign('m', 'p', 'mod'))).toBe(true)
    expect(decide(room(RULES_NEXT, ASSIGN), assign('o', 'p', 'mod'))).toBe(true)
  })

  test("what a role's overwrites allow has to be within the author's channel permissions", () => {
    const rows = { 'r:low': { allow: wire('DeleteMessages') } }
    const plain = room(RULES_NEXT, ASSIGN, 0, rows)
    expect(decide(plain, assign('m', 'd', 'low'))).toBe(false)
    const holder = room(RULES_NEXT, ASSIGN | P.ManageMessages, 0, rows)
    expect(decide(holder, assign('m', 'd', 'low'))).toBe(true)
    const manager = room(RULES_NEXT, ASSIGN | P.ManageChannels, 0, rows)
    expect(decide(manager, assign('m', 'd', 'low'))).toBe(false)
    const base = {
      'r:low': { allow: wire('SendMessages') },
      'r:everyone': { deny: wire('SendMessages') },
    }
    expect(decide(room(RULES_NEXT, ASSIGN, 0, base), assign('m', 'd', 'low'))).toBe(false)
    expect(
      decide(room(RULES_NEXT, ASSIGN | P.ManageChannels, 0, base), assign('m', 'd', 'low'))
    ).toBe(true)
    expect(decide(room(RULES_VERSION, P.ManageRoles, 0, rows), assign('m', 'd', 'low'))).toBe(true)
    const gone = room(RULES_NEXT, ASSIGN, 0, rows, { kind: 'text', gone: true })
    expect(decide(gone, assign('m', 'd', 'low'))).toBe(true)
  })

  test('managing a role needs Manage roles and a rank above it', () => {
    for (const rules of [RULES_VERSION, RULES_NEXT]) {
      const F = room(rules, P.ManageRoles)
      expect(decide(F, ev('role_del', 'm', { role: 'low' }))).toBe(true)
      expect(decide(F, ev('role_del', 'm', { role: 'mgr' }))).toBe(false)
      expect(decide(F, ev('role_del', 'm', { role: 'top' }))).toBe(false)
      expect(decide(F, ev('role_move', 'm', { role: 'low', pos: 4 }))).toBe(true)
      expect(decide(F, ev('role_move', 'm', { role: 'low', pos: 6 }))).toBe(false)
      expect(decide(F, ev('role_bits', 'm', { role: 'low', bit: P.ManageRoles, on: true }))).toBe(
        true
      )
      expect(decide(F, ev('role_bits', 'd', { role: 'low', bit: P.Kick, on: true }))).toBe(false)
      expect(decide(F, ev('role_del', 'o', { role: 'top' }))).toBe(true)
    }
    expect(decide(room(RULES_NEXT, ASSIGN), ev('role_del', 'm', { role: 'low' }))).toBe(false)
  })

  test('kicks and bans need the permission and a rank above the member', () => {
    for (const rules of [RULES_VERSION, RULES_NEXT]) {
      const F = room(rules, P.Kick | P.Ban)
      expect(decide(F, ev('kick', 'm', { to: 'd' }))).toBe(true)
      expect(decide(F, ev('ban', 'm', { to: 'p' }))).toBe(true)
      expect(decide(F, ev('kick', 'd', { to: 'm' }))).toBe(false)
      expect(decide(F, ev('kick', 'm', { to: 'o' }))).toBe(false)
      expect(decide(F, ev('ban', 'd', { to: 'p' }))).toBe(false)
      expect(decide(F, ev('kick', 'd', { to: 'p' }))).toBe(true)
      expect(decide(F, ev('kick', 'd', { to: 'd' }))).toBe(false)
    }
  })
})

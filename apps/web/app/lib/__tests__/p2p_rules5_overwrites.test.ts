import { describe, expect, test } from 'bun:test'
import {
  authCore,
  canSend,
  canView,
  channelPerms,
  P,
  RULES_NEXT,
  RULES_VERSION,
  rulesOf,
  simpleCtx,
  type AclContent,
  type AclEv,
  type ChanFacts,
} from '../p2p/acl/rules'
import type { FactsQ } from '../p2p/acl/facts'
import { fromWire, toWire, bit } from '../perms'

// A room with an owner, a channel manager 'm' (role 'mgr' at position 5), a moderator 'd' (role
// 'mod' at position 3, with Manage messages) and a member 'p' (role 'low' at position 1).
const wire = (...names: string[]) =>
  toWire(
    names.map(bit).reduce((a, b) => a + b, 0n),
    RULES_NEXT
  )
const BASE = wire('ViewChannels', 'SendMessages', 'AddReactions')
const room = (
  rules: number,
  rows: Record<string, { allow?: number; deny?: number }> = {},
  mgr: number = P.ManageChannels
) => {
  const bits = new Map([
    ['everyone', BASE],
    ['mgr', mgr],
    ['mod', P.ManageMessages],
    ['low', 0],
  ])
  const holds = new Map([
    ['m', new Set(['mgr'])],
    ['d', new Set(['mod'])],
    ['p', new Set(['low'])],
  ])
  const pos = new Map([
    ['mgr', 5],
    ['mod', 3],
    ['low', 1],
  ])
  return {
    rules,
    owners: new Set(['o']),
    mem: new Set(['o', 'm', 'd', 'p']),
    roles: new Set(['mgr', 'mod', 'low']),
    bits,
    holds,
    pos,
    overwrites: new Map([['c', new Map(Object.entries(rows))]]),
    channels: new Map([['c', { kind: 'text' }]]),
  } as unknown as FactsQ & ChanFacts
}
const chperm = (a: string, subj: string, allow: number, deny: number): AclEv =>
  ({
    id: 'e',
    t: 'chperm',
    a,
    dev: 'd',
    c: { ch: 'c', subj, allow, deny } as unknown as AclContent,
  }) as unknown as AclEv
const decide = (F: FactsQ & ChanFacts, e: AclEv) => authCore(e, simpleCtx(F, e.a))

describe('channel overwrites under rules 5', () => {
  test('a rules version this app does not decide under reads as the current one', () => {
    expect([2, 4, 5, 3, 6, null, '5'].map(rulesOf)).toEqual([2, 4, 5, 4, 4, 4, 4])
    expect(RULES_NEXT).toBe(RULES_VERSION + 1)
  })

  test('Manage channels passes base bits only, and owners keep moderation bits', () => {
    const rows = { 'r:everyone': { deny: wire('ViewChannels', 'DeleteMessages') } }
    const next = room(RULES_NEXT, rows, P.ManageChannels | P.ManageMessages)
    const current = room(RULES_VERSION, rows, P.ManageChannels | P.ManageMessages)
    const mask = (F: ChanFacts, who: string) => fromWire(channelPerms(F, who, 'c'), RULES_NEXT)
    expect(channelPerms(current, 'm', 'c')).toBe(0x7fffffff)
    expect(mask(next, 'm') & bit('DeleteMessages')).toBe(0n)
    expect(mask(next, 'm') & bit('SendMessages')).toBe(bit('SendMessages'))
    expect(mask(next, 'o') & bit('DeleteMessages')).toBe(bit('DeleteMessages'))
    expect(canView(next, 'p', 'c')).toBe(false)
    expect(canSend(next, 'p', 'c')).toBe(false)
    expect(canSend(next, 'm', 'c')).toBe(true)
  })

  test('without View a member holds nothing, where rules 4 keep Send in the mask', () => {
    const rows = { 'u:p': { deny: wire('ViewChannels') } }
    expect(channelPerms(room(RULES_NEXT, rows), 'p', 'c')).toBe(0)
    expect(channelPerms(room(RULES_VERSION, rows), 'p', 'c') & P.SendMessages).toBe(P.SendMessages)
  })

  test('a manager allows only what they hold in the channel', () => {
    const next = room(RULES_NEXT)
    const current = room(RULES_VERSION)
    const allowSend = chperm('m', 'r:low', wire('SendMessages'), 0)
    const allowDelete = chperm('m', 'r:low', wire('DeleteMessages'), 0)
    expect(decide(next, allowSend)).toBe(true)
    expect(decide(next, allowDelete)).toBe(false)
    expect(decide(current, allowDelete)).toBe(true)
    expect(decide(next, chperm('o', 'r:low', wire('DeleteMessages'), 0))).toBe(true)
    const holder = room(RULES_NEXT, {}, P.ManageChannels | P.ManageMessages)
    expect(decide(holder, allowDelete)).toBe(true)
  })

  test('lifting a deny counts as allowing, and removing an allow does not', () => {
    const denied = room(RULES_NEXT, { 'r:low': { deny: wire('MentionEveryone') } })
    expect(decide(denied, chperm('m', 'r:low', 0, 0))).toBe(false)
    expect(decide(denied, chperm('m', 'r:low', 0, wire('MentionEveryone', 'SendMessages')))).toBe(
      true
    )
    const allowed = room(RULES_NEXT, { 'r:low': { allow: wire('DeleteMessages') } })
    expect(decide(allowed, chperm('m', 'r:low', 0, 0))).toBe(true)
  })

  test('denying a moderation bit needs holding it', () => {
    const next = room(RULES_NEXT)
    const deny = chperm('m', 'r:mod', 0, wire('DeleteMessages'))
    expect(decide(next, deny)).toBe(false)
    expect(decide(room(RULES_VERSION), deny)).toBe(true)
    expect(decide(room(RULES_NEXT, {}, P.ManageChannels | P.ManageMessages), deny)).toBe(true)
    expect(decide(next, chperm('m', 'r:mod', 0, wire('SendMessages')))).toBe(true)
  })

  test('the subject has to rank below the author', () => {
    const next = room(RULES_NEXT)
    expect(decide(next, chperm('d', 'r:mgr', wire('SendMessages'), 0))).toBe(false)
    expect(decide(next, chperm('p', 'r:low', wire('SendMessages'), 0))).toBe(false)
    expect(decide(next, chperm('m', 'x', wire('SendMessages'), 0))).toBe(false)
  })
})

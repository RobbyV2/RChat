import { beforeAll, describe, expect, test } from 'bun:test'
import {
  NOT_BELOW,
  NO_DENY,
  NO_GRANT,
  TRIS,
  bitsBlock,
  clearBlock,
  everyoneItems,
  modeBlock,
  p2pMaskIn,
  groupItems,
  matchItems,
  orderSubjects,
  permItems,
  ruleBlock,
  ruleItems,
  triBlock,
  triOf,
  viewAs,
  withTri,
  type RuleSource,
} from '../perm_source'
import { HOSTED, bit, fromWire, hasBit, maskOr, registry, toWire } from '../perms'
import {
  P,
  RULES_NEXT,
  authCore,
  permsQ,
  simpleCtx,
  type AclContent,
  type AclEv,
  type ChanFacts,
} from '../p2p/acl/rules'
import type { FactsQ } from '../p2p/acl/facts'
import { ChannelPermBit, Perm } from '../types'
import { loadPerms } from './helpers/perms'

beforeAll(() => loadPerms())

const names = (items: { name: string }[]) => items.map(i => i.name)

const VIEW = ChannelPermBit.ViewChannels
const SEND = ChannelPermBit.SendMessages

describe('the permissions each side offers', () => {
  test('hosted servers offer every live hosted permission with its own words', () => {
    const items = permItems(HOSTED)
    expect(names(items)).toEqual(
      registry()
        .filter(b => b.hosted === 'live')
        .map(b => b.name)
    )
    const by = (name: string) => items.find(i => i.name === name)!
    expect(by('MentionEveryone')).toMatchObject({
      label: 'Mention everyone and roles',
      group: 'Text',
      bit: Perm.MentionEveryone,
      channel: true,
    })
    expect(by('Kick')).toMatchObject({ label: 'Kick and ban', group: 'Moderation' })
    expect(by('ManageRoles')).toMatchObject({ group: 'Management', channel: false })
    expect(by('Connect').group).toBe('Voice')
    expect(names(items)).not.toContain('BanMembers')
  })

  test('P2P rooms offer the wire bits their rules know, rules-5 bits only from rules 5', () => {
    const v4 = permItems(4)
    expect(v4.map(i => [i.name, i.bit])).toEqual([
      ['ManageChannels', P.ManageChannels],
      ['DeleteMessages', P.ManageMessages],
      ['Kick', P.Kick],
      ['MentionEveryone', P.MentionEveryone],
      ['ManageServer', P.ManageServer],
      ['ManageRoles', P.ManageRoles],
      ['ViewChannels', P.ViewChannel],
      ['SendMessages', P.SendMessages],
      ['BanMembers', P.Ban],
      ['CreateInvites', P.Invite],
    ])
    expect(v4.find(i => i.name === 'Kick')!.label).toBe('Kick')
    expect(v4.find(i => i.name === 'BanMembers')!.label).toBe('Ban')
    expect(v4.find(i => i.name === 'CreateInvites')!.label).toBe('Invite')
    expect(names(permItems(2))).toEqual(names(v4))
    const v5 = names(permItems(5))
    for (const name of [
      'AddReactions',
      'AttachFiles',
      'Connect',
      'PinMessages',
      'AssignRoles',
      'TimeoutMembers',
      'ManageProfiles',
    ])
      expect(v5).toContain(name)
    for (const name of ['ReadHistory', 'CreatePolls']) expect(v5).not.toContain(name)
  })

  test('@everyone holds what every member starts with on hosted servers, anything in P2P', () => {
    expect(names(everyoneItems(HOSTED))).toEqual(
      registry()
        .filter(b => b.hosted === 'live' && b.everyone)
        .map(b => b.name)
    )
    expect(names(everyoneItems(4))).toEqual(names(permItems(4)))
    expect(names(everyoneItems(5))).toEqual(names(permItems(5)))
  })

  test('a rule carries the channel permissions of its place', () => {
    const text = names(ruleItems(HOSTED, 'text'))
    expect(text).toContain('SendMessages')
    expect(text).toContain('PinMessages')
    expect(text).not.toContain('Connect')
    expect(text).not.toContain('Kick')
    expect(names(ruleItems(HOSTED, 'voice'))).toEqual(['ViewChannels', 'Connect', 'Speak', 'Video'])
    const category = names(ruleItems(HOSTED, 'category'))
    expect(category).toContain('Connect')
    expect(category).toContain('SendMessages')
    expect(names(ruleItems(4, 'text'))).toEqual(['ViewChannels', 'SendMessages'])
    expect(names(ruleItems(4, 'voice'))).toEqual(['ViewChannels'])
    expect(names(ruleItems(4, 'category'))).toEqual(['ViewChannels', 'SendMessages'])
    const v5 = names(ruleItems(5, 'text'))
    expect(v5).toContain('AddReactions')
    expect(v5).toContain('DeleteMessages')
    expect(v5).not.toContain('Speak')
    expect(names(ruleItems(5, 'voice'))).toEqual(['ViewChannels', 'Connect', 'Speak', 'Video'])
    const k5 = names(ruleItems(5, 'category'))
    expect(k5).toContain('Speak')
    expect(k5).toContain('PinMessages')
    expect(k5).not.toContain('ReadHistory')
  })

  test('search keeps the items with every word in their label or hint; groups keep their order', () => {
    const items = permItems(HOSTED)
    expect(names(matchItems(items, 'send'))).toEqual(['SendMessages', 'BypassSlowmode'])
    expect(names(matchItems(items, '  MESSAGES  manage '))).toEqual(['DeleteMessages'])
    expect(names(matchItems(items, 'polls close'))).toEqual(['DeleteMessages'])
    expect(matchItems(items, 'nothing like this')).toEqual([])
    expect(matchItems(items, '')).toHaveLength(items.length)
    const groups = groupItems(matchItems(items, 'manage'))
    expect(groups.map(g => g.group)).toEqual(['Moderation', 'Management'])
    expect(groupItems(items).map(g => g.group)).toEqual([
      'General',
      'Text',
      'Voice',
      'Moderation',
      'Management',
    ])
  })
})

describe('the three states of a permission in a rule', () => {
  test('allow, inherit and deny each set one mask and clear the other', () => {
    const pin = ChannelPermBit.PinMessages
    const bypass = ChannelPermBit.BypassSlowmode
    let rule = withTri(undefined, pin, 'allow')
    expect(rule).toEqual({ allow: pin, deny: 0 })
    rule = withTri(rule, bypass, 'deny')
    expect(triOf(rule, pin)).toBe('allow')
    expect(triOf(rule, bypass)).toBe('deny')
    expect(triOf(rule, VIEW)).toBe('inherit')
    rule = withTri(rule, pin, 'deny')
    expect(rule).toEqual({ allow: 0, deny: maskOr(pin, bypass) })
    rule = withTri(withTri(rule, pin, 'inherit'), bypass, 'inherit')
    expect(rule).toEqual({ allow: 0, deny: 0 })
    expect(triOf(undefined, VIEW)).toBe('inherit')
  })

  test('refusals read as the shared rules decide them', () => {
    const manager = maskOr(VIEW, SEND)
    expect(ruleBlock(manager, false, undefined, { allow: SEND, deny: 0 }, true)).toBeNull()
    expect(
      ruleBlock(manager, false, undefined, { allow: Perm.DeleteMessages, deny: 0 }, true)
    ).toBe(NO_GRANT)
    expect(
      ruleBlock(manager, false, undefined, { allow: 0, deny: Perm.DeleteMessages }, true)
    ).toBe(NO_DENY)
    const mod = maskOr(manager, Perm.DeleteMessages)
    expect(ruleBlock(mod, false, undefined, { allow: 0, deny: Perm.DeleteMessages }, false)).toBe(
      NOT_BELOW
    )
    expect(ruleBlock(0, true, undefined, { allow: Perm.DeleteMessages, deny: 0 }, false)).toBeNull()
    expect(bitsBlock(Perm.Kick, false, 0, Perm.Kick)).toBeNull()
    expect(bitsBlock(Perm.Kick, false, 0, Perm.ManageRoles)).toBe(NO_GRANT)
    expect(bitsBlock(Perm.Kick, false, Perm.ManageRoles, 0)).toBeNull()
  })
})

const hosted = (over: Partial<RuleSource> = {}): RuleSource => ({
  ruleset: HOSTED,
  place: 'text',
  everyone: 'everyone',
  rows: [],
  canonical: bits => bits,
  mine: maskOr(maskOr(VIEW, SEND), Perm.DeleteMessages),
  also: [],
  exempt: false,
  subjectOk: subject => subject !== 'r:9',
  lock: () => null,
  merges: true,
  write: async () => undefined,
  clear: async () => undefined,
  everyoneBits: maskOr(VIEW, SEND),
  roleBits: { 'r:1': 0, 'r:9': 0 },
  memberRoles: subject => (subject === 'u:erin' ? ['r:1'] : []),
  restrictView: false,
  restrictSend: false,
  ...over,
})

describe("a place's rules as the editors read them", () => {
  test('each button says why it is refused, or nothing', () => {
    const src = hosted({ rows: [{ subject: 'r:9', allow: 0, deny: 0, merge: false }] })
    expect(triBlock(src, 'r:1', SEND, 'deny')).toBeNull()
    expect(triBlock(src, 'r:1', ChannelPermBit.PinMessages, 'allow')).toBe(NO_GRANT)
    expect(triBlock(src, 'r:1', Perm.DeleteMessages, 'deny')).toBeNull()
    expect(triBlock(src, 'r:9', Perm.DeleteMessages, 'deny')).toBe(NOT_BELOW)
    expect(
      triBlock(hosted({ exempt: true }), 'r:9', ChannelPermBit.PinMessages, 'allow')
    ).toBeNull()
    const locked = hosted({ lock: s => (s === 'r:1' ? 'Locked' : null) })
    expect(triBlock(locked, 'r:1', SEND, 'allow')).toBe('Locked')
    expect(clearBlock(locked, 'r:1')).toBe('Locked')
  })

  test('taking a rule away is refused when it stops allowing a moderation permission above you', () => {
    const rows = [
      { subject: 'r:9', allow: Perm.DeleteMessages, deny: 0, merge: false },
      { subject: 'r:1', allow: ChannelPermBit.PinMessages, deny: 0, merge: false },
    ]
    const src = hosted({ rows })
    expect(clearBlock(src, 'r:9')).toBe(NOT_BELOW)
    expect(clearBlock(src, 'r:1')).toBeNull()
  })

  test('switching a member rule between override and combine is checked as taking it away and back', () => {
    const rows = [{ subject: 'u:bob', allow: 0, deny: Perm.DeleteMessages, merge: false }]
    expect(modeBlock(hosted({ rows }), 'u:bob')).toBeNull()
    expect(modeBlock(hosted({ rows, mine: maskOr(VIEW, SEND) }), 'u:bob')).toBe(NO_GRANT)
    expect(modeBlock(hosted({ rows, subjectOk: () => false }), 'u:bob')).toBe(NOT_BELOW)
    expect(modeBlock(hosted({ rows, exempt: true, subjectOk: () => false }), 'u:bob')).toBeNull()
  })

  test("a category's rule is checked in every channel it is copied to", () => {
    const src = hosted({ also: [maskOr(VIEW, SEND)] })
    expect(triBlock(hosted(), 'r:1', Perm.DeleteMessages, 'deny')).toBeNull()
    expect(triBlock(src, 'r:1', Perm.DeleteMessages, 'deny')).toBe(NO_DENY)
    expect(triBlock(src, 'r:1', SEND, 'allow')).toBeNull()
    const rows = [{ subject: 'r:1', allow: Perm.DeleteMessages, deny: 0, merge: false }]
    expect(clearBlock(hosted({ rows, also: [maskOr(VIEW, SEND)] }), 'r:1')).toBeNull()
    expect(clearBlock(hosted({ rows, also: [VIEW], subjectOk: () => false }), 'r:1')).toBe(
      NOT_BELOW
    )
  })

  test('View as an admin or an owner keeps what they hold everywhere', () => {
    const rows = [
      { subject: 'everyone', allow: 0, deny: maskOr(VIEW, Perm.DeleteMessages), merge: false },
    ]
    const src = hosted({
      rows,
      memberWho: s =>
        s === 'u:own'
          ? { kind: 'owner' }
          : s === 'u:adm'
            ? { kind: 'admin', mask: Perm.DeleteMessages }
            : undefined,
    })
    expect(viewAs(src, 'u:plain')).toBe(0)
    expect(hasBit(viewAs(src, 'u:own'), Perm.DeleteMessages)).toBe(true)
    expect(hasBit(viewAs(src, 'u:adm'), Perm.DeleteMessages)).toBe(false)
  })

  test('View as follows @everyone, the roles held and a member rule', () => {
    const rows = [
      { subject: 'everyone', allow: 0, deny: VIEW, merge: false },
      { subject: 'r:1', allow: maskOr(VIEW, SEND), deny: 0, merge: false },
      { subject: 'u:dave', allow: 0, deny: SEND, merge: false },
      { subject: 'u:erin', allow: 0, deny: SEND, merge: true },
    ]
    const src = hosted({ rows, memberRoles: () => ['r:1'] })
    expect(viewAs(src, 'everyone')).toBe(0)
    const role = viewAs(src, 'r:1')
    expect([hasBit(role, VIEW), hasBit(role, SEND)]).toEqual([true, true])
    const dave = viewAs(src, 'u:dave')
    expect([hasBit(dave, VIEW), hasBit(dave, SEND)]).toEqual([true, false])
    const erin = viewAs(src, 'u:erin')
    expect([hasBit(erin, VIEW), hasBit(erin, SEND)]).toEqual([true, true])
    const open = hosted({ rows: [], restrictSend: true })
    expect([
      hasBit(viewAs(open, 'everyone'), VIEW),
      hasBit(viewAs(open, 'everyone'), SEND),
    ]).toEqual([true, false])
  })

  test("P2P rows in wire bits are read through the room's rules", () => {
    const src = hosted({
      ruleset: 4,
      everyone: 'r:everyone',
      canonical: bits => fromWire(bits, 4),
      rows: [
        { subject: 'r:everyone', allow: 0, deny: P.SendMessages, merge: false },
        { subject: 'r:A', allow: P.SendMessages, deny: 0, merge: false },
      ],
      everyoneBits: P.ViewChannel | P.SendMessages,
      roleBits: { 'r:A': 0 },
      exempt: true,
    })
    const plain = viewAs(src, 'r:everyone')
    expect([hasBit(plain, VIEW), hasBit(plain, SEND)]).toEqual([true, false])
    const held = viewAs(src, 'r:A')
    expect([hasBit(held, VIEW), hasBit(held, SEND)]).toEqual([true, true])
    expect(triBlock(src, 'r:A', P.ManageMessages, 'allow')).toBeNull()
  })

  test('subjects list @everyone, then roles by rank, then members by name', () => {
    const name = (s: string) => ({ 'u:b': 'Bea', 'u:a': 'Zed', 'r:2': 'Two', 'r:1': 'One' })[s] ?? s
    expect(
      orderSubjects(
        ['u:b', 'r:1', 'everyone', 'u:a', 'r:2', 'r:gone'],
        'everyone',
        ['r:2', 'r:1'],
        name
      )
    ).toEqual(['everyone', 'r:2', 'r:1', 'r:gone', 'u:b', 'u:a'])
  })
})

// A rules-5 room: a channel manager 'm' (role 'mgr', with Manage channels and Manage messages
// at position 5), a member 'p' (role 'low', position 1), a channel 'c' and a category 'k'.
const wire = (...names: string[]) =>
  toWire(
    names.map(bit).reduce((a, b) => a + b, 0),
    RULES_NEXT
  )
const room = (rows: Record<string, Record<string, { allow?: number; deny?: number }>>) =>
  ({
    rules: RULES_NEXT,
    owners: new Set(['o']),
    mem: new Set(['o', 'm', 'p']),
    roles: new Set(['mgr', 'low']),
    bits: new Map([
      ['everyone', wire('ViewChannels', 'SendMessages')],
      ['mgr', P.ManageChannels | P.ManageMessages],
      ['low', 0],
    ]),
    holds: new Map([
      ['m', new Set(['mgr'])],
      ['p', new Set(['low'])],
    ]),
    pos: new Map([
      ['mgr', 5],
      ['low', 1],
    ]),
    overwrites: new Map(Object.entries(rows).map(([ch, r]) => [ch, new Map(Object.entries(r))])),
    channels: new Map([['c', { kind: 'text' }]]),
  }) as unknown as FactsQ & ChanFacts

describe('the P2P editor and the room rules agree', () => {
  const cases: Record<string, Record<string, { allow?: number; deny?: number }>>[] = [
    {},
    { k: { 'r:mgr': { deny: wire('DeleteMessages') } } },
    {
      c: {
        'r:everyone': { deny: wire('ViewChannels', 'AttachFiles') },
        'r:low': { allow: wire('PinMessages') },
      },
    },
  ]
  test('every button the editor offers is a rule change the rules admit, and no other', () => {
    for (const rows of cases)
      for (const [ch, place] of [
        ['c', 'text'],
        ['k', 'category'],
      ] as const) {
        const F = room(rows)
        const over = Object.fromEntries(
          Object.entries(rows[ch] ?? {}).map(([k, o]) => [
            k,
            { allow: o.allow ?? 0, deny: o.deny ?? 0 },
          ])
        )
        const src = hosted({
          ruleset: RULES_NEXT,
          place,
          everyone: 'r:everyone',
          canonical: bits => fromWire(bits, RULES_NEXT),
          rows: Object.entries(over).map(([subject, o]) => ({ subject, ...o, merge: false })),
          mine: p2pMaskIn(
            permsQ(F, 'm'),
            false,
            ['mgr'],
            'm',
            over,
            { restrictView: false, restrictSend: false },
            RULES_NEXT
          ),
          subjectOk: () => true,
        })
        for (const item of ruleItems(RULES_NEXT, place))
          for (const tri of TRIS) {
            const before = over['r:low']
            const after = withTri(before, item.bit, tri)
            if (after.allow === (before?.allow ?? 0) && after.deny === (before?.deny ?? 0)) continue
            const e = {
              id: 'e',
              t: 'chperm',
              a: 'm',
              dev: 'd',
              c: {
                ch,
                subj: 'r:low',
                allow: after.allow,
                deny: after.deny,
              } as unknown as AclContent,
            } as unknown as AclEv
            expect([ch, item.name, tri, triBlock(src, 'r:low', item.bit, tri) === null]).toEqual([
              ch,
              item.name,
              tri,
              authCore(e, simpleCtx(F, 'm')),
            ])
          }
      }
  })

  test('a manager may give and take what Manage channels passes, not moderation they lack', () => {
    const F = room({ k: { 'r:mgr': { deny: wire('DeleteMessages') } } })
    const over = { 'r:mgr': { allow: 0, deny: wire('DeleteMessages') } }
    const mine = p2pMaskIn(
      permsQ(F, 'm'),
      false,
      ['mgr'],
      'm',
      over,
      { restrictView: false, restrictSend: false },
      RULES_NEXT
    )
    const src = hosted({
      ruleset: RULES_NEXT,
      place: 'category',
      everyone: 'r:everyone',
      canonical: bits => fromWire(bits, RULES_NEXT),
      rows: [{ subject: 'r:mgr', ...over['r:mgr'], merge: false }],
      mine,
    })
    expect(triBlock(src, 'r:low', wire('BypassSlowmode'), 'allow')).toBeNull()
    expect(triBlock(src, 'r:low', wire('BypassSlowmode'), 'deny')).toBeNull()
    expect(triBlock(src, 'r:low', wire('AttachFiles'), 'allow')).toBeNull()
    expect(triBlock(src, 'r:low', wire('DeleteMessages'), 'allow')).toBe(NO_GRANT)
  })
})

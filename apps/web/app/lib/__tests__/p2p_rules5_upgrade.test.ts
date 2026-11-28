import { describe, expect, test } from 'bun:test'
import {
  canSend,
  canView,
  carriedBits,
  carriedRule,
  CHANGE_PROFILE,
  checkedUnder,
  contentLack,
  everyoneBits,
  holdsIn,
  knownRules,
  mayDelete,
  mayMentionEveryone,
  mayPin,
  P,
  PROFILES,
  RULES_NEXT,
  RULES_TEXT_ONLY,
  RULES_VERSION,
  rulesOf,
  skipsSlowMode,
  textOnlyRules,
  TIMEOUT,
  type ChanFacts,
} from '../p2p/acl/rules'
import type { FactsQ } from '../p2p/acl/facts'
import { EVERYONE_BITS } from '../p2p/server'
import { UPGRADE_KEEPS, upgradeChanges, upgradeOffered } from '../p2p_upgrade'
import { bit, toWire } from '../perms'

const wire = (...names: string[]) =>
  toWire(
    names.map(bit).reduce((a, b) => a | b, 0n),
    RULES_NEXT
  )
const SEND_GROUP = wire('AddReactions', 'AttachFiles', 'EmbedLinks', 'StartThreads')
const VIEW_GROUP = wire('Connect', 'Speak', 'Video')

describe('the current rules', () => {
  test('are rules 5, and rooms of rules 2 and 4 are still read', () => {
    expect([RULES_VERSION, RULES_NEXT, RULES_TEXT_ONLY]).toEqual([5, 5, 4])
    expect([2, 3, 4, 5, 6, '5', null].map(knownRules)).toEqual([
      true,
      false,
      true,
      true,
      false,
      false,
      false,
    ])
    expect([2, 4, 5, 3, undefined].map(rulesOf)).toEqual([2, 4, 5, 5, 5])
    expect([2, 4, 5, null].map(textOnlyRules)).toEqual([false, true, true, false])
  })

  test('a stored message keeps the rules it was checked under, in rooms that check messages', () => {
    expect(checkedUnder('C', 4)).toEqual({ contentRules: 4 })
    expect(checkedUnder('C', 5)).toEqual({ contentRules: 5 })
    expect(checkedUnder('C', 2)).toEqual({})
    expect(checkedUnder('A', 5)).toEqual({})
    expect(checkedUnder('C', null)).toEqual({})
  })

  test('everyone in a new server views, sends, reacts, attaches, talks and changes their profile', () => {
    expect(EVERYONE_BITS).toBe(everyoneBits())
    expect(EVERYONE_BITS).toBe(
      (P.Invite | P.ViewChannel | P.SendMessages | SEND_GROUP | VIEW_GROUP | CHANGE_PROFILE) >>> 0
    )
    expect(EVERYONE_BITS & (P.ManageChannels | P.Kick | wire('PinMessages'))).toBe(0)
  })
})

describe('what an upgrade to rules 5 gives roles and channel rules', () => {
  test('each bit brings what it covered before', () => {
    const got = (bits: number, everyone = false) => carriedBits(bits, everyone, 4)
    expect(got(0)).toBe(0)
    expect(got(0, true)).toBe(CHANGE_PROFILE)
    expect(got(P.SendMessages)).toBe((P.SendMessages | SEND_GROUP) >>> 0)
    expect(got(P.ViewChannel)).toBe((P.ViewChannel | VIEW_GROUP) >>> 0)
    expect(got(P.ManageMessages)).toBe(
      (P.ManageMessages | wire('PinMessages', 'BypassSlowmode')) >>> 0
    )
    expect(got(P.ManageChannels)).toBe((P.ManageChannels | wire('BypassSlowmode')) >>> 0)
    expect(got(P.ManageRoles)).toBe((P.ManageRoles | wire('AssignRoles')) >>> 0)
    expect(got(P.Kick)).toBe((P.Kick | TIMEOUT | PROFILES) >>> 0)
    expect(got(P.Ban | P.Invite | P.ManageServer | P.MentionEveryone)).toBe(
      P.Ban | P.Invite | P.ManageServer | P.MentionEveryone
    )
    expect(carriedBits(P.SendMessages, true, 2)).toBe(
      (P.SendMessages | SEND_GROUP | CHANGE_PROFILE) >>> 0
    )
  })

  test('a room of rules 5 is carried as it is', () => {
    expect(carriedBits(P.SendMessages | P.Kick, true, RULES_NEXT)).toBe(P.SendMessages | P.Kick)
    const rule = { allow: P.SendMessages, deny: P.ViewChannel }
    expect(carriedRule(rule, RULES_NEXT)).toBe(rule)
  })

  test('a channel rule allows or denies what sending and viewing covered', () => {
    expect(carriedRule({ allow: P.SendMessages, deny: 0 }, 4)).toEqual({
      allow: (P.SendMessages | SEND_GROUP) >>> 0,
      deny: 0,
    })
    expect(carriedRule({ allow: P.ViewChannel, deny: P.SendMessages }, 4)).toEqual({
      allow: (P.ViewChannel | VIEW_GROUP) >>> 0,
      deny: (P.SendMessages | SEND_GROUP) >>> 0,
    })
    expect(carriedRule({ allow: 0, deny: 0 }, 2)).toEqual({ allow: 0, deny: 0 })
  })
})

type Rows = Record<string, { allow?: number; deny?: number }>
interface World {
  everyone: number
  roles: Record<string, number>
  holds: Record<string, string[]>
  channels: Record<string, { rows: Rows; restrict_view?: true; restrict_send?: true }>
}

const facts = (w: World, rules: number): FactsQ & ChanFacts => {
  const up = rules >= RULES_NEXT
  const bits = (b: number, everyone: boolean) => (up ? carriedBits(b, everyone, 4) : b)
  const row = (o: { allow?: number; deny?: number }) => {
    const plain = { allow: o.allow ?? 0, deny: o.deny ?? 0 }
    return up ? carriedRule(plain, 4) : plain
  }
  const members = ['o', ...Object.keys(w.holds)]
  return {
    rules,
    owners: new Set(['o']),
    mem: new Set(members),
    roles: new Set(Object.keys(w.roles)),
    bits: new Map([
      ['everyone', bits(w.everyone, true)],
      ...Object.entries(w.roles).map(([id, b]) => [id, bits(b, false)] as [string, number]),
    ]),
    holds: new Map(Object.entries(w.holds).map(([ik, held]) => [ik, new Set(held)])),
    pos: new Map(Object.keys(w.roles).map((id, i) => [id, i + 1])),
    overwrites: new Map(
      Object.entries(w.channels).map(([ch, c]) => [
        ch,
        new Map(Object.entries(c.rows).map(([subj, o]) => [subj, row(o)])),
      ])
    ),
    channels: new Map(
      Object.entries(w.channels).map(([ch, c]) => [
        ch,
        {
          kind: 'text',
          slow: 30,
          ...(c.restrict_view ? { restrict_view: true } : {}),
          ...(c.restrict_send ? { restrict_send: true } : {}),
        },
      ])
    ),
  } as unknown as FactsQ & ChanFacts
}

const att = [{ h: 'A'.repeat(43), size: 1, blocks: 1, name: 'a.txt', mime: 'text/plain' }]

// What a member may do in a channel, as rules 4 decided it and as rules 5 decide it. Under
// rules 4 every post needed sending, so what a member may do to others' messages, mention and
// skip is compared where they send.
const before = (F: ChanFacts, who: string, ch: string) => {
  const send = canSend(F, who, ch)
  return {
    view: canView(F, who, ch),
    send,
    files: send,
    react: send,
    pin: send && mayPin(F, who, ch),
    remove: send && mayDelete(F, who, ch),
    everyone: send && mayMentionEveryone(F, who, ch),
    fast: send && skipsSlowMode(F, who, ch),
    voice: canView(F, who, ch),
  }
}
const after = (F: ChanFacts, who: string, ch: string) => {
  const lack = (t: string, c: Record<string, unknown>) => contentLack(F, who, ch, t, c) === null
  const send = lack('msg', { body: 'hi' })
  return {
    view: canView(F, who, ch),
    send,
    files: lack('msg', { body: '', att }),
    react: lack('react', { target: 't', key: 'x', on: true }),
    pin: lack('pin', { target: 't', on: true }),
    remove: send && mayDelete(F, who, ch),
    everyone: send && mayMentionEveryone(F, who, ch),
    fast: send && skipsSlowMode(F, who, ch),
    voice: ['Connect', 'Speak', 'Video'].every(name => holdsIn(F, who, ch, name)),
  }
}

const WORLDS: Record<string, World> = {
  'everyone views and sends': {
    everyone: P.ViewChannel | P.SendMessages | P.Invite,
    roles: {
      mgr: P.ManageChannels,
      mod: P.ManageMessages | P.Kick,
      helper: P.ManageRoles | P.MentionEveryone,
      low: 0,
    },
    holds: { m: ['mgr'], d: ['mod'], h: ['helper'], p: ['low'], n: [] },
    channels: {
      open: { rows: {} },
      quiet: {
        rows: { 'r:everyone': { deny: P.SendMessages }, 'r:low': { allow: P.SendMessages } },
      },
      hidden: { rows: { 'r:everyone': { deny: P.ViewChannel }, 'u:n': { allow: P.ViewChannel } } },
      mine: { rows: { 'u:p': { deny: P.ViewChannel }, 'u:d': { deny: P.SendMessages } } },
      staff: { rows: { 'r:mod': { allow: P.ViewChannel } }, restrict_view: true },
      news: { rows: { 'r:helper': { allow: P.SendMessages } }, restrict_send: true },
    },
  },
  'everyone only views, and a role sends': {
    everyone: P.ViewChannel,
    roles: { talk: P.SendMessages, mod: P.ManageMessages, mgr: P.ManageChannels },
    holds: { t: ['talk'], d: ['mod'], m: ['mgr'], n: [], b: ['talk', 'mod'] },
    channels: {
      open: { rows: {} },
      all: { rows: { 'r:everyone': { allow: P.SendMessages } } },
      shut: { rows: { 'r:talk': { deny: P.SendMessages | P.ViewChannel } } },
    },
  },
  'nobody views without a role': {
    everyone: 0,
    roles: { in: P.ViewChannel | P.SendMessages, look: P.ViewChannel },
    holds: { a: ['in'], l: ['look'], n: [] },
    channels: { open: { rows: {} }, read: { rows: { 'r:in': { deny: P.SendMessages } } } },
  },
}

describe('a rules-4 room carried to rules 5', () => {
  for (const [name, w] of Object.entries(WORLDS))
    test(`${name}: every member does in every channel what they did before`, () => {
      const [old, now] = [facts(w, 4), facts(w, RULES_NEXT)]
      for (const who of ['o', ...Object.keys(w.holds)])
        for (const ch of Object.keys(w.channels))
          expect([who, ch, after(now, who, ch)]).toEqual([who, ch, before(old, who, ch)])
    })

  test('an edit after the upgrade is what changes it', () => {
    const w = WORLDS['everyone views and sends']
    const now = facts(w, RULES_NEXT)
    expect(contentLack(now, 'n', 'open', 'react', { target: 't', key: 'x', on: true })).toBeNull()
    const edited = facts(w, RULES_NEXT)
    ;(edited.overwrites as Map<string, Map<string, unknown>>)
      .get('open')!
      .set('r:everyone', { allow: 0, deny: wire('AddReactions') })
    expect(contentLack(edited, 'n', 'open', 'react', { target: 't', key: 'x', on: true })).toBe(
      'react'
    )
    expect(contentLack(edited, 'n', 'open', 'msg', { body: 'hi' })).toBeNull()
  })
})

describe('a timed-out member under rules 5', () => {
  const F = facts(WORLDS['everyone views and sends'], RULES_NEXT)
  const lack = (t: string, c: Record<string, unknown>, timedOut: boolean) =>
    contentLack(F, 'd', 'open', t, c, RULES_NEXT, timedOut)

  test('holds what a timeout keeps: viewing, and nothing that posts', () => {
    expect(lack('msg', { body: 'hi' }, false)).toBeNull()
    expect(lack('msg', { body: 'hi' }, true)).toBe('send')
    expect(lack('react', { target: 't', key: 'x', on: true }, true)).toBe('react')
    expect(lack('pin', { target: 't', on: true }, true)).toBe('send')
    expect(lack('redact', { target: 't' }, true)).toBeNull()
    expect(holdsIn(F, 'd', 'open', 'ViewChannels', RULES_NEXT, true)).toBe(true)
    expect(holdsIn(F, 'd', 'open', 'DeleteMessages', RULES_NEXT, true)).toBe(false)
    expect(holdsIn(F, 'd', 'open', 'Connect', RULES_NEXT, true)).toBe(false)
  })

  test('earlier rules read no timeouts', () => {
    const old = facts(WORLDS['everyone views and sends'], 4)
    expect(canSend(old, 'd', 'open', 4)).toBe(true)
    expect(holdsIn(old, 'd', 'open', 'SendMessages', 4, true)).toBe(true)
  })
})

describe('the upgrade offer', () => {
  test('is for servers of earlier rules, and lists what each gains', () => {
    expect([2, 4, 5].map(upgradeOffered)).toEqual([true, true, false])
    expect(upgradeChanges(5)).toEqual([])
    expect(upgradeChanges(4)).toHaveLength(4)
    expect(upgradeChanges(2)).toEqual(['Text-only channels', ...upgradeChanges(4)])
    for (const line of [...upgradeChanges(2), UPGRADE_KEEPS]) expect(line).not.toContain('—')
  })
})

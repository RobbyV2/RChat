import { describe, expect, test } from 'bun:test'
import {
  authCore,
  CONTENT_PIN,
  CONTENT_REDACT,
  contentLack,
  holdsIn,
  mayDelete,
  mayMentionEveryone,
  mayPin,
  P,
  RULES_NEXT,
  RULES_TEXT_ONLY,
  simpleCtx,
  skipsSlowMode,
  type AclContent,
  type AclEv,
  type ChanFacts,
} from '../p2p/acl/rules'
import type { FactsQ } from '../p2p/acl/facts'
import { emptySummary, type Summary } from '../p2p/acl/summary'
import { channelMaskOf } from '../p2p/state'
import { channelViews } from '../p2p/server/views'
import { voiceAllowed, voiceRights } from '../p2p/server/search'
import type { ServerCtx } from '../p2p/server/context'
import { bit, hasBit, toWire } from '../perms'

const wire = (...names: string[]) =>
  toWire(
    names.map(bit).reduce((a, b) => a + b, 0n),
    RULES_NEXT
  )
const BASE = wire(
  'ViewChannels',
  'SendMessages',
  'AddReactions',
  'AttachFiles',
  'StartThreads',
  'Connect',
  'Speak',
  'Video'
)

// A room with an owner 'o', a channel manager 'm' (role 'mgr' at 5), a moderator 'd' (role 'mod'
// at 3 with Manage messages), a pinner 'q' (role 'pin' at 2 with the rules-5 Pin messages bit)
// and a member 'p' (role 'low' at 1), in channel 'c'.
const room = (rules: number, rows: Record<string, { allow?: number; deny?: number }> = {}) =>
  ({
    rules,
    owners: new Set(['o']),
    mem: new Set(['o', 'm', 'd', 'q', 'p']),
    roles: new Set(['mgr', 'mod', 'pin', 'low']),
    bits: new Map([
      ['everyone', rules < RULES_NEXT ? P.ViewChannel | P.SendMessages : BASE],
      ['mgr', P.ManageChannels],
      ['mod', P.ManageMessages],
      ['pin', rules < RULES_NEXT ? 0 : wire('PinMessages', 'BypassSlowmode', 'MentionEveryone')],
      ['low', 0],
    ]),
    holds: new Map([
      ['m', new Set(['mgr'])],
      ['d', new Set(['mod'])],
      ['q', new Set(['pin'])],
      ['p', new Set(['low'])],
    ]),
    pos: new Map([
      ['mgr', 5],
      ['mod', 3],
      ['pin', 2],
      ['low', 1],
    ]),
    overwrites: new Map([['c', new Map(Object.entries(rows))]]),
    channels: new Map([['c', { kind: 'text', slow: 30 }]]),
  }) as unknown as FactsQ & ChanFacts

const att = [{ h: 'A'.repeat(43), size: 1, blocks: 1, name: 'a.txt', mime: 'text/plain' }]
const lack = (F: ChanFacts, who: string, t: string, c: Record<string, unknown> | null) =>
  contentLack(F, who, 'c', t, c)

describe('content under rules 5', () => {
  test('each kind needs its own permission in the channel', () => {
    const rows = { 'r:low': { deny: wire('AddReactions', 'AttachFiles') } }
    const F = room(RULES_NEXT, rows)
    expect(lack(F, 'p', 'msg', { body: 'hi' })).toBeNull()
    expect(lack(F, 'p', 'msg', { body: '', att })).toBe('attach')
    expect(lack(F, 'p', 'msg', { body: '', fwd: { name: 'x', ts: 1, body: '', att } })).toBe(
      'attach'
    )
    expect(lack(F, 'd', 'msg', { body: '', att })).toBeNull()
    expect(lack(F, 'p', 'react', { target: 't', key: 'x', on: true })).toBe('react')
    expect(lack(F, 'p', 'react', { target: 't', key: 'x', on: false })).toBeNull()
    expect(lack(F, 'd', 'react', { target: 't', key: 'x', on: true })).toBeNull()
    expect(lack(F, 'p', 'pin', { target: 't', on: true })).toBe('pin')
    expect(lack(F, 'd', 'pin', { target: 't', on: true })).toBe('pin')
    expect(lack(F, 'q', 'pin', { target: 't', on: true })).toBeNull()
    expect(lack(F, 'o', 'pin', { target: 't', on: true })).toBeNull()
    expect(lack(F, 'p', 'edit', { target: 't', body: 'x' })).toBeNull()
  })

  test('sending decides everything but reactions, and View decides those', () => {
    const quiet = room(RULES_NEXT, { 'r:everyone': { deny: wire('SendMessages') } })
    expect(lack(quiet, 'p', 'msg', { body: 'hi' })).toBe('send')
    expect(lack(quiet, 'q', 'pin', { target: 't', on: true })).toBe('send')
    expect(lack(quiet, 'p', 'react', { target: 't', key: 'x', on: true })).toBeNull()
    expect(lack(quiet, 'm', 'msg', { body: 'hi', att })).toBeNull()
    const hidden = room(RULES_NEXT, { 'u:p': { deny: wire('ViewChannels') } })
    expect(lack(hidden, 'p', 'react', { target: 't', key: 'x', on: false })).toBe('react')
    expect(lack(hidden, 'p', 'msg', { body: 'hi' })).toBe('send')
  })

  test('a deletion asks for View only: who may delete does so without Send', () => {
    const quiet = room(RULES_NEXT, { 'r:everyone': { deny: wire('SendMessages') } })
    const take = { target: 't', ch: 'c' }
    expect(lack(quiet, 'p', 'msg', { body: 'hi' })).toBe('send')
    expect(lack(quiet, 'd', 'redact', take)).toBeNull()
    expect(lack(quiet, 'p', 'redact', take)).toBeNull()
    expect(lack(quiet, 'p', 'redact', null)).toBeNull()
    const hidden = room(RULES_NEXT, { 'u:p': { deny: wire('ViewChannels') } })
    expect(lack(hidden, 'p', 'redact', take)).toBe('send')
    expect(lack(hidden, 'd', 'redact', take)).toBeNull()
  })

  test('content held without its body asks for the least its kind needs', () => {
    const F = room(RULES_NEXT, { 'r:low': { deny: wire('AddReactions', 'AttachFiles') } })
    expect(lack(F, 'p', 'react', null)).toBeNull()
    expect(lack(F, 'p', 'msg', null)).toBeNull()
    expect(lack(F, 'p', 'pin', null)).toBe('pin')
  })

  test('pins, deletes, mentions and slow mode each have their permission', () => {
    const F = room(RULES_NEXT)
    expect(['o', 'm', 'd', 'q', 'p'].map(who => mayPin(F, who, 'c'))).toEqual([
      true,
      false,
      false,
      true,
      false,
    ])
    expect(['o', 'm', 'd', 'q', 'p'].map(who => mayDelete(F, who, 'c'))).toEqual([
      true,
      false,
      true,
      false,
      false,
    ])
    expect(['o', 'm', 'd', 'q', 'p'].map(who => skipsSlowMode(F, who, 'c'))).toEqual([
      true,
      true,
      false,
      true,
      false,
    ])
    expect(['o', 'd', 'q', 'p'].map(who => mayMentionEveryone(F, who, 'c'))).toEqual([
      true,
      false,
      true,
      false,
    ])
    const denied = room(RULES_NEXT, {
      'r:pin': { deny: wire('PinMessages', 'BypassSlowmode', 'MentionEveryone') },
      'u:p': { allow: wire('PinMessages') },
    })
    expect([mayPin(denied, 'q', 'c'), mayPin(denied, 'p', 'c')]).toEqual([false, true])
    expect(skipsSlowMode(denied, 'q', 'c')).toBe(false)
    expect(mayMentionEveryone(denied, 'q', 'c')).toBe(false)
    expect(holdsIn(denied, 'o', 'c', 'PinMessages')).toBe(true)
  })

  test('up to rules 4 Manage messages pins and deletes, and leaves slow mode out', () => {
    const F = room(RULES_TEXT_ONLY, { 'u:d': { deny: P.ManageMessages } })
    expect(['o', 'm', 'd', 'p'].map(who => mayPin(F, who, 'c'))).toEqual([true, false, true, false])
    expect(['o', 'm', 'd', 'p'].map(who => mayDelete(F, who, 'c'))).toEqual([
      true,
      false,
      true,
      false,
    ])
    expect(['o', 'm', 'd', 'p'].map(who => skipsSlowMode(F, who, 'c'))).toEqual([
      true,
      true,
      false,
      false,
    ])
    expect(skipsSlowMode(room(RULES_TEXT_ONLY), 'd', 'c')).toBe(true)
  })

  test('the authority of a pin and of a redaction follows the channel', () => {
    const ev = (t: string, a: string, c: Record<string, unknown>): AclEv =>
      ({ id: 'e', t, a, dev: 'x', c: c as unknown as AclContent }) as unknown as AclEv
    const decide = (F: FactsQ & ChanFacts, e: AclEv) => authCore(e, simpleCtx(F, e.a))
    const next = room(RULES_NEXT, { 'r:mod': { deny: wire('DeleteMessages') } })
    const current = room(RULES_TEXT_ONLY, { 'r:mod': { deny: P.ManageMessages } })
    expect(decide(next, ev(CONTENT_PIN, 'q', { ch: 'c' }))).toBe(true)
    expect(decide(next, ev(CONTENT_PIN, 'd', { ch: 'c' }))).toBe(false)
    expect(decide(current, ev(CONTENT_PIN, 'd', { ch: 'c' }))).toBe(true)
    expect(decide(next, ev(CONTENT_REDACT, 'd', { to: 'p', ch: 'c' }))).toBe(false)
    expect(decide(next, ev(CONTENT_REDACT, 'd', { to: 'p', ch: 'other' }))).toBe(true)
    expect(decide(current, ev(CONTENT_REDACT, 'd', { to: 'p', ch: 'c' }))).toBe(true)
    expect(decide(next, ev(CONTENT_REDACT, 'p', { to: 'p', ch: 'c' }))).toBe(true)
    expect(decide(next, ev(CONTENT_REDACT, 'o', { to: 'd', ch: 'c' }))).toBe(true)
  })
})

const C = 'AAAAAAAAAAA'
// The same room as the page reads it from its summary, with a voice channel 'v'.
const summary = (
  rules: number,
  rows: Record<string, { allow?: number; deny?: number }> = {}
): Summary => {
  const member = (roles: string[]) =>
    ({ m: 'join', roles, perms: 0, devs: [] }) as unknown as Summary['members']['']
  const role = (bits: number, pos: number) => ({ bits, pos }) as unknown as Summary['roles']['']
  const later = rules >= RULES_NEXT
  return {
    ...emptySummary(),
    rules,
    owners: ['o'],
    members: { o: member([]), m: member(['mgr']), d: member(['mod']), p: member(['low']) },
    roles: {
      mgr: role(P.ManageChannels, 5),
      mod: role(P.ManageMessages, 3),
      low: role(0, 1),
    },
    everyone: later ? BASE : P.ViewChannel | P.SendMessages,
    channels: {
      [C]: { name: 'general', kind: 'text', slow: 30 } as unknown as AclContent,
      v: { name: 'lounge', kind: 'voice' } as unknown as AclContent,
    },
    overwrites: { v: rows, [C]: rows } as unknown as Summary['overwrites'],
  }
}

describe('what the page reads', () => {
  test('a channel view carries the mask the controls ask', () => {
    const lim = { name: 100, topic: 100 }
    const held = (s: Summary, who: string) =>
      channelViews(s, who, 'join', lim).find(c => c.id === C)?.perms ?? 0n
    const names = (mask: bigint) =>
      ['SendMessages', 'AddReactions', 'PinMessages', 'DeleteMessages', 'BypassSlowmode'].filter(
        n => hasBit(mask, bit(n))
      )
    const current = summary(RULES_TEXT_ONLY)
    expect(names(held(current, 'p'))).toEqual(['SendMessages', 'AddReactions'])
    expect(names(held(current, 'd'))).toEqual([
      'SendMessages',
      'AddReactions',
      'PinMessages',
      'DeleteMessages',
      'BypassSlowmode',
    ])
    expect(hasBit(held(current, 'm'), bit('BypassSlowmode'))).toBe(true)
    const denied = summary(RULES_TEXT_ONLY, { 'u:d': { deny: P.ManageMessages } })
    expect(names(held(denied, 'd'))).toEqual([
      'SendMessages',
      'AddReactions',
      'PinMessages',
      'DeleteMessages',
    ])
    const next = summary(RULES_NEXT)
    expect(names(held(next, 'p'))).toEqual(['SendMessages', 'AddReactions'])
    expect(names(held(next, 'd'))).toEqual(['SendMessages', 'AddReactions', 'DeleteMessages'])
    expect(names(held(next, 'm'))).toEqual(['SendMessages', 'AddReactions', 'BypassSlowmode'])
    expect(channelMaskOf(next, 'x', C)).toBe(channelMaskOf(next, 'p', C))
  })

  test('voice asks for Connect, and counts audio with Speak and video with Video', () => {
    const cx = (s: Summary) =>
      ({
        me: 'o',
        sumOf: () => s,
        isVoiceChannel: (_room: string, ch: string) => ch === 'v',
        myMembership: () => 'join',
        may: () => 'full',
        ensureRt: () => ({ views: new Map([['p\nv', true]]), sum: s }),
      }) as unknown as ServerCtx
    const denied = { 'r:low': { deny: wire('Connect', 'Speak', 'Video') } }
    expect(voiceAllowed(cx(summary(RULES_NEXT, denied)), 'r', 'v', 'p')).toBe(false)
    expect(voiceAllowed(cx(summary(RULES_NEXT)), 'r', 'v', 'p')).toBe(true)
    expect(voiceAllowed(cx(summary(RULES_TEXT_ONLY, denied)), 'r', 'v', 'p')).toBe(true)
    expect(voiceRights(cx(summary(RULES_NEXT, denied)), 'r', 'v', 'p')).toEqual({
      speak: false,
      video: false,
    })
    const mute = { 'r:low': { deny: wire('Speak') } }
    expect(voiceRights(cx(summary(RULES_NEXT, mute)), 'r', 'v', 'p')).toEqual({
      speak: false,
      video: true,
    })
    expect(voiceRights(cx(summary(RULES_NEXT, mute)), 'r', 'v', 'o')).toEqual({
      speak: true,
      video: true,
    })
    expect(voiceRights(cx(summary(RULES_TEXT_ONLY, mute)), 'r', 'v', 'p')).toEqual({
      speak: true,
      video: true,
    })
  })
})

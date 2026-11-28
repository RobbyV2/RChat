import { expect, test } from 'bun:test'
import {
  CAN_ALL,
  CAN_NONE,
  canOf,
  hostedMask,
  keepMyPerms,
  legacyMask,
  p2pMask,
  unruledMask,
  withChannel,
} from '../channel_perms'
import { HOSTED, baseBits, channelMask } from '../perms'
import { ChannelPermBit as B, Perm, type Channel, type ServerDetail } from '../types'

const channel = (id: number, more: Partial<Channel> = {}): Channel => ({
  id,
  name: `c${id}`,
  kind: 'text',
  slowmode_seconds: 0,
  ...more,
})

test('a channel update without permissions keeps the ones already known', () => {
  expect(keepMyPerms(channel(1, { my_perms: 7n }), channel(1, { name: 'new' }))).toEqual(
    channel(1, { name: 'new', my_perms: 7n })
  )
  expect(keepMyPerms(channel(1, { my_perms: 7n }), channel(1, { my_perms: 0n })).my_perms).toBe(0n)
  expect(keepMyPerms(undefined, channel(1))).toEqual(channel(1))
  expect(keepMyPerms(channel(1), channel(1, { my_perms: 3n })).my_perms).toBe(3n)
})

test('an update replaces only its own channel', () => {
  const list = [channel(1, { my_perms: 7n }), channel(2, { my_perms: 9n })]
  expect(withChannel(list, channel(2, { topic: 'hi' }))).toEqual([
    channel(1, { my_perms: 7n }),
    channel(2, { topic: 'hi', my_perms: 9n }),
  ])
  expect(withChannel(list, channel(3))).toEqual(list)
})

const held = (mask: bigint) =>
  Object.entries(canOf(mask))
    .filter(([, on]) => on)
    .map(([name]) => name)

test('a mask answers each control, and nothing without View channels', () => {
  const mask = B.ViewChannels + B.SendMessages + B.AddReactions + B.Connect + Perm.DeleteMessages
  expect(held(mask)).toEqual(['send', 'react', 'manage', 'connect'])
  expect(held(mask - B.ViewChannels)).toEqual([])
  expect(held(B.ViewChannels + B.PinMessages + B.BypassSlowmode + Perm.MentionEveryone)).toEqual([
    'pin',
    'mention',
    'bypassSlowmode',
  ])
  expect(held(B.ViewChannels + B.AttachFiles + B.EmbedLinks + B.CreatePolls)).toEqual([
    'attach',
    'embed',
    'polls',
  ])
  expect(held(B.ViewChannels + B.StartThreads + B.Speak + B.Video)).toEqual([
    'threads',
    'speak',
    'video',
  ])
  expect(Object.values(CAN_ALL).every(Boolean)).toBe(true)
  expect(Object.values(CAN_NONE).some(Boolean)).toBe(false)
})

test('a channel without its own answer follows its read-only mark and your permissions', () => {
  expect(held(legacyMask(false, 0n))).toEqual([
    'send',
    'react',
    'attach',
    'embed',
    'polls',
    'threads',
    'connect',
    'speak',
    'video',
  ])
  expect(held(legacyMask(true, 0n))).toEqual(['connect', 'speak', 'video'])
  expect(held(legacyMask(true, Perm.DeleteMessages))).toEqual([
    'pin',
    'manage',
    'connect',
    'speak',
    'video',
    'bypassSlowmode',
  ])
  expect(canOf(legacyMask(true, Perm.ManageChannels)).bypassSlowmode).toBe(true)
  expect(canOf(legacyMask(true, Perm.PinMessages)).pin).toBe(true)
  expect(canOf(legacyMask(true, Perm.PinMessages)).manage).toBe(false)
  expect(canOf(legacyMask(false, Perm.MentionEveryone)).mention).toBe(true)
})

test('a hosted channel reads its own mask once a member has one', () => {
  const detail = {
    channels: [channel(1, { my_perms: B.ViewChannels + B.SendMessages }), channel(2)],
    read_only: [2],
  } as unknown as ServerDetail
  expect(held(hostedMask(detail, 1, Perm.DeleteMessages, true))).toEqual(['send'])
  expect(canOf(hostedMask(detail, 1, 0n, false)).connect).toBe(true)
  expect(canOf(hostedMask(detail, 2, 0n, true)).send).toBe(false)
  expect(canOf(hostedMask(detail, 2, Perm.DeleteMessages, true)).manage).toBe(true)
  expect(canOf(hostedMask(detail, 3, 0n, true)).send).toBe(true)
  expect(canOf(hostedMask(undefined, 1, 0n, true)).send).toBe(true)
  expect(canOf(hostedMask(detail, null, 0n, true)).send).toBe(true)
})

test('a channel without rules of its own reads like the shared rules evaluate it', () => {
  const pool = [
    Perm.ManageChannels,
    Perm.DeleteMessages,
    Perm.MentionEveryone,
    B.PinMessages,
    B.BypassSlowmode,
    B.ViewChannels,
    B.SendMessages,
    B.AddReactions,
    B.Connect,
    B.Video,
  ]
  const base = baseBits()
  for (let pick = 0; pick < 2 ** pool.length; pick++) {
    const chosen = pool.filter((_, i) => (pick >> i) & 1).reduce((m, b) => m | b, 0n)
    for (const bits of [chosen, chosen | (base & ~B.ViewChannels)])
      for (const flags of [0, 1, 2, 3]) {
        const restrictView = (flags & 1) !== 0
        const restrictSend = (flags & 2) !== 0
        const shared = channelMask(
          { kind: 'member', roles: bits },
          0n,
          { restrictView, restrictSend, roles: [] },
          HOSTED,
          false,
          false
        )
        const ours = unruledMask(
          { restrict_view: restrictView, restrict_send: restrictSend },
          false,
          bits
        )
        expect([bits, flags, ours]).toEqual([bits, flags, shared])
      }
  }
})

test('a new channel follows the server permissions the server reports', () => {
  const everyone = baseBits() & ~(B.AddReactions + B.AttachFiles)
  const detail = (my: bigint) =>
    ({
      channels: [
        channel(1, { my_perms: B.ViewChannels }),
        channel(2),
        channel(3, { restrict_view: true }),
      ],
      read_only: [],
      my_perms: my,
    }) as unknown as ServerDetail
  const plain = canOf(hostedMask(detail(everyone), 2, 0n, true))
  expect([plain.send, plain.react, plain.attach, plain.pin, plain.bypassSlowmode]).toEqual([
    true,
    false,
    false,
    false,
    false,
  ])
  const modr = canOf(
    hostedMask(detail(everyone | Perm.DeleteMessages), 2, Perm.DeleteMessages, true)
  )
  expect([modr.manage, modr.pin, modr.bypassSlowmode]).toEqual([true, false, false])
  const mgr = canOf(hostedMask(detail(everyone | Perm.ManageChannels), 3, 0n, true))
  expect([mgr.send, mgr.react, mgr.bypassSlowmode, mgr.pin]).toEqual([true, true, true, false])
  expect(hostedMask(detail(everyone), 3, 0n, true)).toBe(0n)
  expect(held(hostedMask(detail(everyone), 1, 0n, true))).toEqual([])
  expect(canOf(hostedMask(detail(0n), 2, 0n, false)).react).toBe(true)
})

test('a P2P channel gives its mask to a joined identity only', () => {
  const channels = [{ id: 'a', perms: B.ViewChannels + B.Connect }]
  expect(held(p2pMask({ me: 'join', channels }, 'a') ?? 0n)).toEqual(['connect'])
  expect(p2pMask({ me: 'join', channels }, 'b')).toBeNull()
  expect(p2pMask({ me: 'invite', channels }, 'a')).toBe(0n)
  expect(p2pMask({ me: null, channels }, 'a')).toBe(0n)
  expect(p2pMask(undefined, 'a')).toBeNull()
})

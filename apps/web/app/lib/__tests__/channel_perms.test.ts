import { expect, test } from 'bun:test'
import { keepMyPerms, toggledRule, withChannel } from '../channel_perms'
import type { Channel } from '../types'

const channel = (id: number, more: Partial<Channel> = {}): Channel => ({
  id,
  name: `c${id}`,
  kind: 'text',
  slowmode_seconds: 0,
  ...more,
})

test('a channel update without permissions keeps the ones already known', () => {
  expect(keepMyPerms(channel(1, { my_perms: 7 }), channel(1, { name: 'new' }))).toEqual(
    channel(1, { name: 'new', my_perms: 7 })
  )
  expect(keepMyPerms(channel(1, { my_perms: 7 }), channel(1, { my_perms: 0 })).my_perms).toBe(0)
  expect(keepMyPerms(undefined, channel(1))).toEqual(channel(1))
  expect(keepMyPerms(channel(1), channel(1, { my_perms: 3 })).my_perms).toBe(3)
})

test('an update replaces only its own channel', () => {
  const list = [channel(1, { my_perms: 7 }), channel(2, { my_perms: 9 })]
  expect(withChannel(list, channel(2, { topic: 'hi' }))).toEqual([
    channel(1, { my_perms: 7 }),
    channel(2, { topic: 'hi', my_perms: 9 }),
  ])
  expect(withChannel(list, channel(3))).toEqual(list)
})

test('a toggled rule keeps the masks and mode it was listed with', () => {
  const rule = {
    subject: 'u:ann',
    can_view: true,
    can_send: false,
    can_read_history: true,
    allow: 0,
    deny: 2 ** 15,
    mode: 'merge' as const,
  }
  expect(toggledRule(rule, 'can_view')).toEqual({ ...rule, can_view: false })
  expect(toggledRule(rule, 'can_send')).toEqual({ ...rule, can_send: true })
  const flags = { subject: 'r:1', can_view: true, can_send: true, can_read_history: false }
  expect(toggledRule(flags, 'can_read_history')).toEqual({ ...flags, can_read_history: true })
})

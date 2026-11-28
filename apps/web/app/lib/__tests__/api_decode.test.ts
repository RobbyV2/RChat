import { describe, expect, test } from 'bun:test'
import { decode } from '../api/gen'
import { readJson } from '../api/masks'

const user = { username: 'bob', display_name: 'Bob', avatar_kind: 'identicon', avatar_color: null }

const message = {
  id: 7,
  channel_id: 1,
  dm_id: null,
  thread_root_id: null,
  author: user,
  content: 'hi',
  created_at: 10,
  reply_count: 0,
  media: null,
  embeds: [],
  kind: 'user',
  call: null,
  reply_to: null,
  extra_from_a_newer_server: true,
}

describe('generated decoders', () => {
  test('a message reads with the fields a server left out as null, and newer fields dropped', () => {
    const r = decode.Message.parse(message)
    if (!r.ok) throw new Error('not read')
    expect(r.value.edited_at).toBeNull()
    expect(r.value.forward).toBeNull()
    expect(r.value.author.avatar_image).toBeNull()
    expect('extra_from_a_newer_server' in r.value).toBe(false)
  })

  test('a field of the wrong type is an issue with its path', () => {
    const r = decode.Message.parse({ ...message, author: { ...user, username: 5 } })
    expect(r).toEqual({
      ok: false,
      unknown: false,
      issue: { path: 'author.username', expected: 'a string' },
    })
  })

  test('masks read as bigints, from the wire or from readJson', () => {
    const role = {
      id: 1,
      name: 'r',
      color: '#fff',
      perms: 6,
      position: 0,
      color_names: true,
      display_position: null,
      hoist: false,
      icon: null,
      mentionable: false,
    }
    const wire = decode.Role.parse(role)
    const read = decode.Role.parse(readJson(JSON.stringify(role)))
    expect(wire.ok && wire.value.perms).toBe(6n)
    expect(read.ok && read.value.perms).toBe(6n)
  })

  test('events read by their type; an unknown type is from a newer server', () => {
    const stub = { type: 'message_updated', id: 7, stub: true, thread_root_id: null, edited_at: 9 }
    const full = { type: 'message_updated', server: 's', channel_id: 1, message }
    const a = decode.WsEvent.parse(stub)
    const b = decode.WsEvent.parse(full)
    expect(a.ok && a.value.type).toBe('message_updated')
    expect(a.ok && a.value.type === 'message_updated' && !a.value.message && a.value.id).toBe(7)
    expect(b.ok && b.value.type === 'message_updated' && b.value.message?.id).toBe(7)
    expect(decode.WsEvent.parse({ type: 'a_newer_event', x: 1 })).toEqual({
      ok: false,
      unknown: true,
    })
  })

  test('a list leaves out the items of a kind this build has no name for', () => {
    const r = decode.WsEvent.array().parse([{ type: 'resync' }, { type: 'a_newer_event' }])
    expect(r.ok && r.value.map(e => e.type)).toEqual(['resync'])
  })
})

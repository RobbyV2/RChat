import { afterAll, describe, expect, test } from 'bun:test'
import { dropDeletedIn, patchMessages, updatedRow } from '../slices/messages'
import { resetSessionCaches, useStore, type RChatState } from '../store'
import { msg } from './fixtures'

afterAll(resetSessionCaches)

const state = (over: Partial<RChatState>): RChatState => ({ ...useStore.getState(), ...over })
const ids = (s: Partial<RChatState>, key: string) => s.messages![key].map(m => m.id)

describe('messages reducers', () => {
  test("message_updated keeps the row's position and its reactions", () => {
    const reactions = [{ emoji: '👍', count: 2, me: true, first_at: 1 }]
    const s = state({
      messages: {
        c1: [msg(1), msg(2, { content: 'old', reactions }), msg(3)],
        c2: [msg(9)],
      },
    })
    const out = patchMessages(s, 2, updatedRow(msg(2, { content: 'new', edited_at: 5 })))
    expect(ids(out, 'c1')).toEqual([1, 2, 3])
    expect(out.messages!.c1[1].content).toBe('new')
    expect(out.messages!.c1[1].edited_at).toBe(5)
    expect(out.messages!.c1[1].reactions).toBe(reactions)
    expect(out.messages!.c2).toBe(s.messages.c2)
    expect(patchMessages(s, 7, updatedRow(msg(7)))).toEqual({})
  })

  test('messages_deleted removes exactly the listed ids', () => {
    let s = state({
      messages: { c1: [msg(1), msg(2), msg(3), msg(4)], c2: [msg(5)], t2: [msg(6)] },
      panel: null,
      replying: {},
      editing: null,
    })
    for (const id of [2, 4]) s = { ...s, ...dropDeletedIn(s, id, null) }
    expect(ids(s, 'c1')).toEqual([1, 3])
    expect(ids(s, 'c2')).toEqual([5])
    expect(s.messages.t2).toBeUndefined()
  })

  test('a deleted thread reply lowers its root count', () => {
    const s = state({
      messages: { c1: [msg(1, { reply_count: 2 })], t1: [msg(2, { thread_root_id: 1 })] },
      panel: null,
      replying: {},
      editing: null,
    })
    const out = dropDeletedIn(s, 2, 1)
    expect(out.messages!.c1[0].reply_count).toBe(1)
    expect(ids(out, 't1')).toEqual([])
  })
})

import { describe, expect, test } from 'bun:test'
import {
  THREADS_PAGE,
  THREADS_QUERY_MAX,
  hostedThreadPage,
  matchesThread,
  mergeRows,
  pageThreads,
  pingedRows,
  repliesText,
  rootLine,
  threadQuery,
  threadsEmpty,
  type ThreadRow,
} from '../thread_list'
import { msg } from './fixtures'

describe('thread lists', () => {
  test('reply counts read naturally', () => {
    expect(repliesText(1)).toBe('1 reply')
    expect(repliesText(0)).toBe('0 replies')
    expect(repliesText(12)).toBe('12 replies')
  })

  test('the empty list explains threads, the DM with yourself its own way, a search its miss', () => {
    expect(threadsEmpty(false, false)).toEqual({
      title: 'There are no threads',
      body: 'Stay focused on a conversation with a thread.',
    })
    expect(threadsEmpty(false, true).body).toBe(
      'Organize notes and forwarded messages into focused threads.'
    )
    expect(threadsEmpty(true, true).title).toBe('No matching threads')
    for (const copy of [threadsEmpty(false, false), threadsEmpty(true, false)])
      expect(`${copy.title} ${copy.body}`).not.toContain('\u2014')
  })

  test('a search is trimmed, lowercase and capped', () => {
    expect(threadQuery('  Weekend PLANS ')).toBe('weekend plans')
    expect([...threadQuery('é'.repeat(THREADS_QUERY_MAX + 5))].length).toBe(THREADS_QUERY_MAX)
  })

  test('a root shows its first line, or what it holds', () => {
    expect(rootLine({ ...msg(1), content: '**Hi** there\nsecond' }, false)).toEqual({
      text: 'Hi there',
      label: null,
    })
    expect(rootLine({ ...msg(1), content: '' }, true).label).toBe('Attachment')
    expect(rootLine({ ...msg(1), content: '', kind: 'poll' }, false).label).toBe('Poll')
    expect(rootLine({ ...msg(1), content: '' }, false).label).toBe('Message')
    const fwd = {
      author: null,
      created_at: 1,
      source_id: 2,
      origin: null,
      dropped: null,
      origin_channel: null,
      origin_channel_id: null,
      origin_server: null,
      origin_server_channel: null,
    }
    expect(rootLine({ ...msg(1), content: '', forward: fwd }, true).label).toBe('Forwarded message')
  })

  test('local threads: newest reply first, searched by text or name, 50 a page', () => {
    const all = Array.from({ length: THREADS_PAGE + 3 }, (_, i) => ({
      id: `r${String(i).padStart(3, '0')}`,
      last: `k${String(i).padStart(3, '0')}`,
      text: i === 7 ? 'Weekend plans' : `topic ${i}`,
      names: [i === 9 ? 'Robert' : 'Alice'],
    }))
    const first = pageThreads(all, '', null)
    expect(first.items.length).toBe(THREADS_PAGE)
    expect(first.items[0].id).toBe(`r${String(THREADS_PAGE + 2).padStart(3, '0')}`)
    expect(first.next).not.toBeNull()
    const second = pageThreads(all, '', first.next)
    expect(second.items.map(t => t.id)).toEqual(['r002', 'r001', 'r000'])
    expect(second.next).toBeNull()
    expect(pageThreads(all, ' PLANS', null).items.map(t => t.id)).toEqual(['r007'])
    expect(pageThreads(all, 'rob', null).items.map(t => t.id)).toEqual(['r009'])
    expect(pageThreads(all, 'nothing', null)).toEqual({ items: [], next: null })
    expect(matchesThread({ text: 'x', names: [] }, '   ')).toBe(true)
  })

  test('two threads with one sort key keep a stable order across pages', () => {
    const all = [
      { id: 'b', last: 'k1', text: '', names: [] },
      { id: 'a', last: 'k1', text: '', names: [] },
      { id: 'c', last: 'k0', text: '', names: [] },
    ]
    const one = pageThreads(all, '', null, 1)
    const two = pageThreads(all, '', one.next, 1)
    const three = pageThreads(all, '', two.next, 1)
    expect([...one.items, ...two.items, ...three.items].map(t => t.id)).toEqual(['b', 'a', 'c'])
    expect(three.next).toBeNull()
  })

  test('a later page adds only threads not shown yet', () => {
    const row = (key: string): ThreadRow => ({
      key,
      root: msg(Number(key)),
      files: false,
      replies: 1,
      lastAt: 1,
      pinged: false,
    })
    expect(mergeRows([row('1'), row('2')], [row('2'), row('3')]).map(r => r.key)).toEqual([
      '1',
      '2',
      '3',
    ])
  })

  test("the instance's lists: a DM's or a channel's, as rows with their pings", async () => {
    const calls: unknown[][] = []
    const item = (id: number) => ({
      root: msg(id, { reply_count: 3, media: null }),
      last_reply_id: id + 1,
      last_reply_at: 77,
    })
    const api = {
      channelThreads: async (id: number, q: string, cursor: string | null) => {
        calls.push(['channel', id, q, cursor])
        return { items: [item(5)], next: 'n' }
      },
      dmThreads: async (id: number, q: string, cursor: string | null) => {
        calls.push(['dm', id, q, cursor])
        return { items: [item(6)], next: null }
      },
    }
    const dm = await hostedThreadPage(api, 'd4', 'plans', null)
    const channel = await hostedThreadPage(api, 'c9', '', 'cur')
    expect(calls).toEqual([
      ['dm', 4, 'plans', null],
      ['channel', 9, '', 'cur'],
    ])
    expect(dm).toMatchObject({ next: null, items: [{ key: '6', replies: 3, lastAt: 77 }] })
    expect(channel.next).toBe('n')
    expect(pingedRows([...dm.items, ...channel.items], { t5: {} }).map(r => r.pinged)).toEqual([
      false,
      true,
    ])
  })
})

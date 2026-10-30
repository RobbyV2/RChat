import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { allPings, resetSessionCaches, useStore } from '../store'
import {
  allRead,
  compareEntries,
  entryOf,
  freshSource,
  hasMore,
  inboxAction,
  inboxSnippet,
  markedRead,
  mergeEntries,
  refreshHead,
  refreshOnCount,
  sourcesToLoad,
  type InboxAdapter,
  type InboxEntry,
  type SourceState,
} from '../inbox'
import {
  addInboxAdapter,
  inboxAdapters,
  instanceInbox,
  itemNotifies,
  removeInboxAdapter,
  untilFor,
} from '../inbox_source'
import { inboxParams } from '../api'
import { seenGroupMessages } from '../group_pings'
import { EMPTY_NOTIFY, setLevel, setSuppress } from '../notify'
import type { InboxItem, WsEvent } from '../types'
import { me, user } from './fixtures'

afterAll(resetSessionCaches)

const item = (source: InboxItem['source'], id: number, at: number, over: Partial<InboxItem> = {}) =>
  ({
    source,
    id,
    kind: source === 'friend' ? 'friend_request' : source === 'group' ? 'everyone' : 'mention',
    unread: true,
    created_at: at,
    actor: user('bob', { display_name: 'Bob' }),
    emoji: null,
    role: null,
    scope: source === 'friend' ? null : 'c1',
    server: source === 'friend' ? null : 's',
    server_name: source === 'friend' ? null : 'Server',
    channel_name: source === 'friend' ? null : 'general',
    message_id: source === 'friend' ? null : id,
    thread_root_id: null,
    content: source === 'friend' ? null : 'hi',
    media_filename: null,
    ...over,
  }) as InboxItem

const entry = (adapter: string, id: number, at: number) => entryOf(adapter, item('ping', id, at))

const state = (entries: InboxEntry[], next: string | null): SourceState => ({
  ...freshSource(),
  entries,
  next,
  done: next === null,
})

describe('merging sources', () => {
  test('entries come newest first and stop where a source may still fill in', () => {
    const a = state([entry('a', 1, 100), entry('a', 2, 90)], 'more')
    const b = state([entry('b', 3, 95), entry('b', 4, 80), entry('b', 5, 70)], null)
    const merged = mergeEntries({ a, b })
    expect(merged.map(e => e.id)).toEqual([1, 3, 2])
    expect(sourcesToLoad({ a, b })).toEqual(['a'])
    expect(hasMore({ a, b })).toBe(true)
    const done = { a: state(a.entries, null), b }
    expect(mergeEntries(done).map(e => e.id)).toEqual([1, 3, 2, 4, 5])
    expect(sourcesToLoad(done)).toEqual([])
    expect(hasMore(done)).toBe(false)
  })

  test('a source with nothing loaded yet holds the list back', () => {
    const a = state([entry('a', 1, 100)], null)
    const b = freshSource()
    expect(mergeEntries({ a, b })).toEqual([])
    expect(sourcesToLoad({ a, b })).toEqual(['b'])
  })

  test('paging two fake sources gives one ordered list without gaps', async () => {
    const make = (id: string, times: number[]): InboxAdapter => ({
      id,
      load: async (_view, cursor) => {
        const from = cursor ? Number(cursor) : 0
        const page = times.slice(from, from + 2)
        return {
          entries: page.map((t, i) => entry(id, from + i, t)),
          next: from + 2 < times.length ? String(from + 2) : null,
        }
      },
      markRead: async () => {},
      markAll: async () => {},
      open: () => {},
    })
    const adapters = [make('a', [100, 60, 50, 10]), make('b', [90, 80, 70, 20, 5])]
    let sources: Record<string, SourceState> = { a: freshSource(), b: freshSource() }
    const view = { unread: false, kind: null, place: null }
    for (let round = 0; round < 10; round += 1) {
      const ids = Object.values(sources).every(s => !s.entries.length && !s.done)
        ? ['a', 'b']
        : sourcesToLoad(sources)
      if (!ids.length) break
      for (const id of ids) {
        const cur = sources[id]
        const page = await adapters.find(x => x.id === id)!.load(view, cur.next)
        sources = {
          ...sources,
          [id]: state([...cur.entries, ...page.entries], page.next),
        }
      }
      const shown = mergeEntries(sources).map(e => e.created_at)
      expect(shown).toEqual([...shown].sort((x, y) => y - x))
    }
    expect(mergeEntries(sources).map(e => e.created_at)).toEqual([
      100, 90, 80, 70, 60, 50, 20, 10, 5,
    ])
  })

  test('marking read leaves the Unread tab and dims in All', () => {
    const a = state([entry('a', 1, 100), entry('a', 2, 90)], null)
    const key = a.entries[0].key
    expect(markedRead({ a }, key, true).a.entries.map(e => e.id)).toEqual([2])
    const dimmed = markedRead({ a }, key, false).a.entries
    expect(dimmed.map(e => e.unread)).toEqual([false, true])
    expect(markedRead({ a }, 'nope', false).a).toBe(a)
    expect(allRead({ a }, true).a.entries).toEqual([])
    expect(allRead({ a }, false).a.entries.every(e => !e.unread)).toBe(true)
  })

  test('mark all on Unread stops paging until the reload', () => {
    const a = state([entry('a', 1, 100)], 'page2')
    const cleared = allRead({ a }, true).a
    expect(cleared.next).toBeNull()
    expect(cleared.done).toBe(true)
    expect(sourcesToLoad({ a: cleared })).toEqual([])
    expect(allRead({ a }, false).a.next).toBe('page2')
  })
})

describe('live refresh', () => {
  const at = (id: number, t: number, unread = true) => entryOf('a', item('ping', id, t, { unread }))

  test('a new first page merges in front and keeps the deeper pages', () => {
    const loaded = state([at(10, 100), at(9, 90), at(8, 80), at(7, 70), at(6, 60), at(5, 50)], 'p3')
    const page = { entries: [at(11, 110), at(10, 100, false), at(8, 80)], next: 'p2' }
    const out = refreshHead(loaded, page)
    expect(out.entries.map(e => e.id)).toEqual([11, 10, 8, 7, 6, 5])
    expect(out.entries[1].unread).toBe(false)
    expect(out.next).toBe('p3')
    expect(out.done).toBe(false)
    expect(out.loading).toBe(false)
  })

  test('rows of one second keep the order the server pages them in', () => {
    const same = [9, 10, 11, 100].map(id => at(id, 50))
    const g = entryOf('a', item('group', 2, 50))
    const f = entryOf('a', item('friend', 1, 50))
    const sorted = [...same, g, f].sort(compareEntries)
    expect(sorted.map(e => e.key)).toEqual([
      'a:friend:1',
      'a:group:2',
      'a:ping:100',
      'a:ping:11',
      'a:ping:10',
      'a:ping:9',
    ])
    const loaded = state([at(12, 50), at(11, 50), at(10, 50), at(9, 50)], 'p3')
    const out = refreshHead(loaded, { entries: [at(13, 50), at(12, 50)], next: 'p2' })
    expect(out.entries.map(e => e.id)).toEqual([13, 12, 11, 10, 9])
  })

  test('the first page alone when nothing deeper was loaded or nothing is left', () => {
    const loaded = state([at(10, 100)], 'p2')
    const page = { entries: [at(11, 110), at(10, 100)], next: 'n2' }
    const head = refreshHead(loaded, page)
    expect([head.next, head.done]).toEqual(['n2', false])
    expect(refreshHead(loaded, page).entries.map(e => e.id)).toEqual([11, 10])
    const pushed = refreshHead(state([at(10, 100), at(9, 90)], 'p2'), page)
    expect(pushed.entries.map(e => e.id)).toEqual([11, 10, 9])
    expect(pushed.next).toBe('p2')
    const last = refreshHead(loaded, { entries: [at(10, 100)], next: null })
    expect(last.entries.map(e => e.id)).toEqual([10])
    expect(last.done).toBe(true)
    expect(refreshHead(freshSource(), page).entries.map(e => e.id)).toEqual([11, 10])
  })

  test('a count that went down right after marking here does not reload', () => {
    expect(refreshOnCount(3, 4, 0, 10)).toBe(true)
    expect(refreshOnCount(3, 4, 99, 10)).toBe(true)
    expect(refreshOnCount(4, 3, 99, 10)).toBe(false)
    expect(refreshOnCount(4, 3, 5, 10)).toBe(true)
    expect(refreshOnCount(4, 4, 0, 10)).toBe(false)
  })
})

describe('rows', () => {
  test('actions name the kind', () => {
    const e = (over: Partial<InboxItem>) => entryOf('x', item('ping', 1, 1, over))
    expect(inboxAction(e({ kind: 'mention' }))).toBe('mentioned you')
    expect(inboxAction(e({ kind: 'reply' }))).toBe('replied to you')
    expect(inboxAction(e({ kind: 'reaction', emoji: '🎉' }))).toBe('reacted 🎉 to your message')
    expect(inboxAction(e({ kind: 'everyone' }))).toBe('mentioned @everyone')
    expect(inboxAction(e({ kind: 'here' }))).toBe('mentioned @here')
    expect(inboxAction(e({ kind: 'role', role: 'Crew' }))).toBe('mentioned @Crew')
    expect(inboxAction(e({ kind: 'friend_request' }))).toBe('sent you a friend request')
    expect(inboxAction(e({ kind: 'friend_accept' }))).toBe('accepted your friend request')
  })

  test('snippets mask spoilers and markdown like toasts, then profanity; streamer hides them', () => {
    const e = (content: string | null, over: Partial<InboxItem> = {}) =>
      entryOf('x', item('ping', 1, 1, { content, ...over }))
    const mask = (t: string) => t.replace(/darn/g, '****')
    const text = inboxSnippet(e('**hey** ||secret plan|| `darn` <t:0:R>'), false, mask)
    expect(text.includes('secret')).toBe(false)
    expect(text.startsWith('hey ')).toBe(true)
    expect(text).toContain('█')
    expect(text).toContain('****')
    expect(inboxSnippet(e('a ||cut open'), false, mask).includes('cut open')).toBe(false)
    expect(inboxSnippet(e('**hey** darn'), true, mask)).toBe('')
    expect(inboxSnippet(e('', { media_filename: 'darn.png' }), false, mask)).toBe('****.png')
    expect(
      inboxSnippet(e('', { media_filename: 'plot.png', media_spoiler: true }), false, mask)
    ).toBe('Spoiler')
  })

  test('places come from the item', () => {
    expect(entryOf('x', item('ping', 1, 1, { scope: 'd4', server: null })).where).toEqual({
      kind: 'dm',
    })
    expect(entryOf('x', item('friend', 1, 1)).where).toEqual({ kind: 'friends' })
    expect(entryOf('x', item('group', 1, 1, { thread_root_id: 3 })).where).toEqual({
      kind: 'channel',
      server: 's',
      serverName: 'Server',
      channel: 'general',
      thread: true,
    })
  })
})

describe('the instance source', () => {
  test('mark all goes up to the newest ids shown', () => {
    const shown = [
      entryOf('instance', item('ping', 40, 9)),
      entryOf('instance', item('group', 300, 8)),
      entryOf('instance', item('friend', 7, 1)),
    ]
    expect(untilFor({ pings: 41, groups: 100, friends: 2 }, shown)).toEqual({
      pings: 41,
      groups: 300,
      friends: 7,
    })
    expect(untilFor(undefined, [])).toEqual({ pings: 0, groups: 0, friends: 0 })
  })

  test('Unread lists only what would badge under the notification settings', async () => {
    const quiet = setLevel(EMPTY_NOTIFY, { kind: 'channel', id: 2, server: 's' }, 'nothing')
    const prefs = setSuppress(quiet, 's', 'roles', true)
    const role = item('group', 3, 5, { kind: 'role', group_kinds: ['role'] })
    const both = item('group', 4, 5, { kind: 'everyone', group_kinds: ['everyone', 'role'] })
    const nothing = item('ping', 5, 5, { scope: 'c2' })
    expect(itemNotifies(prefs, item('ping', 1, 5))).toBe(true)
    expect(itemNotifies(prefs, item('friend', 2, 5))).toBe(true)
    expect(itemNotifies(prefs, role)).toBe(false)
    expect(itemNotifies(prefs, both)).toBe(true)
    expect(itemNotifies(prefs, nothing)).toBe(false)

    const realFetch = globalThis.fetch
    const urls: string[] = []
    globalThis.fetch = (async (url: string) => {
      urls.push(String(url))
      const later = String(url).includes('cursor=')
      const page = later
        ? { items: [item('ping', 1, 1)], next: null, until: null }
        : { items: [role, nothing], next: 'c2', until: { pings: 9, groups: 9, friends: 0 } }
      return new Response(JSON.stringify(page), { status: 200 })
    }) as unknown as typeof fetch
    try {
      useStore.setState({ notifyPrefs: prefs })
      const unread = await instanceInbox.load({ unread: true, kind: null, place: null }, null)
      expect(unread.entries.map(e => e.id)).toEqual([1])
      expect(unread.next).toBeNull()
      expect(urls).toHaveLength(2)
      const all = await instanceInbox.load({ unread: false, kind: null, place: null }, null)
      expect(all.entries.map(e => e.id)).toEqual([3, 5])
    } finally {
      globalThis.fetch = realFetch
      useStore.setState({ notifyPrefs: EMPTY_NOTIFY })
    }
  })

  test('query strings', () => {
    expect(inboxParams({ unread: true, kind: 'mentions', limit: 10 })).toBe(
      'unread=true&kind=mentions&limit=10'
    )
    expect(inboxParams({ server: 'a b', dms: false })).toBe('server=a+b&limit=30')
    expect(inboxParams({ dms: true })).toBe('dms=true&limit=30')
  })

  test('other sources can be added and removed', () => {
    const p2p: InboxAdapter = { ...instanceInbox, id: 'p2p' }
    addInboxAdapter(p2p)
    expect(inboxAdapters().map(a => a.id)).toEqual(['instance', 'p2p'])
    addInboxAdapter(p2p)
    expect(inboxAdapters().length).toBe(2)
    removeInboxAdapter('p2p')
    expect(inboxAdapters().map(a => a.id)).toEqual(['instance'])
  })

  const realFetch = globalThis.fetch
  afterEach(() => {
    globalThis.fetch = realFetch
  })

  test('loading, marking one and marking all call the API with the bounds', async () => {
    const calls: { url: string; body: unknown }[] = []
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      calls.push({ url: String(url), body: init?.body ? JSON.parse(String(init.body)) : null })
      const page = {
        items: [item('ping', 5, 10), item('group', 77, 9)],
        next: null,
        until: { pings: 6, groups: 80, friends: 1 },
      }
      return new Response(JSON.stringify(String(url).includes('/inbox?') ? page : { ok: true }), {
        status: 200,
      })
    }) as unknown as typeof fetch
    const view = { unread: true, kind: 'mentions' as const, place: 's' }
    const page = await instanceInbox.load(view, null)
    expect(page.entries.map(e => e.key)).toEqual(['instance:ping:5', 'instance:group:77'])
    expect(calls[0].url).toContain('/inbox?unread=true&kind=mentions&server=s&limit=30')
    await instanceInbox.markRead(page.entries[1])
    expect(calls[1].url.endsWith('/inbox/read')).toBe(true)
    expect(calls[1].body).toEqual({ source: 'group', id: 77 })
    await instanceInbox.markAll(view, page.entries)
    expect(calls[2].body).toEqual({
      until: { pings: 6, groups: 80, friends: 1 },
      kind: 'mentions',
      server: 's',
    })
  })
})

describe('group_pings_seen', () => {
  beforeEach(() => {
    useStore.setState({
      me: me('bob', {
        servers: [{ name: 's', display_name: 's', creator: null, is_admin: false }],
      }),
      token: 't',
      guest: false,
      reads: { c1: { lastRead: 0, latest: 9, server: 's' } },
      pings: {},
      groupPings: {
        c1: {
          server: 's',
          items: [
            { message_id: 9, kinds: ['everyone'] },
            { message_id: 8, kinds: ['role'] },
          ],
        },
      },
      notifyPrefs: EMPTY_NOTIFY,
    })
  })

  test('drops the marked messages from the badge', () => {
    expect(allPings(useStore.getState())).toBe(2)
    const ev: WsEvent = { type: 'group_pings_seen', username: 'bob', scope: 'c1', message_ids: [9] }
    useStore.getState().applyWsEvent(ev)
    expect(allPings(useStore.getState())).toBe(1)
    useStore.getState().applyWsEvent({ ...ev, username: 'carol', message_ids: [8] })
    expect(allPings(useStore.getState())).toBe(1)
    useStore.getState().applyWsEvent({ ...ev, message_ids: [8] })
    expect(allPings(useStore.getState())).toBe(0)
    expect(useStore.getState().groupPings).toEqual({})
  })

  test('the pure helper keeps unrelated scopes', () => {
    const g = useStore.getState().groupPings
    expect(seenGroupMessages(g, 'c2', [9])).toBe(g)
    expect(seenGroupMessages(g, 'c1', [1])).toBe(g)
    expect(seenGroupMessages(g, 'c1', [9, 8])).toEqual({})
  })
})

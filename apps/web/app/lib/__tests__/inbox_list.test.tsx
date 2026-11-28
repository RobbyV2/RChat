import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { Loaded } from '../../components/loaded'
import { ApiError } from '../api'
import { ManualTime } from '../clock'
import {
  DEFAULT_VIEW,
  entryOf,
  type InboxAdapter,
  type InboxEntry,
  type SourcePage,
} from '../inbox'
import { inboxLoads } from '../inbox_list'
import type { InboxItem } from '../types'
import { user } from './fixtures'

const entry = (adapter: string, id: number, at: number, unread = true): InboxEntry =>
  entryOf(adapter, {
    source: 'ping',
    id,
    kind: 'mention',
    unread,
    created_at: at,
    actor: user('bob'),
    emoji: null,
    role: null,
    scope: 'c1',
    server: 's',
    server_name: 'Server',
    channel_name: 'general',
    message_id: id,
    thread_root_id: null,
    content: `note ${id}`,
    media_filename: null,
  } as InboxItem)

const settle = async () => {
  for (let i = 0; i < 8; i++) await Promise.resolve()
}

const source = (id: string, answer: (cursor: string | null) => Promise<SourcePage>) => {
  const marked: string[] = []
  const adapter: InboxAdapter = {
    id,
    load: (_view, cursor) => answer(cursor),
    markRead: e => {
      marked.push(e.key)
      return Promise.resolve()
    },
    markAll: (_view, shown) => {
      marked.push(`all:${shown.length}`)
      return Promise.resolve()
    },
    open: () => {},
  }
  return { adapter, marked }
}

const draw = (loads: ReturnType<typeof inboxLoads>) =>
  renderToStaticMarkup(
    <Loaded load={loads.list.get()} what="notifications" empty="caught up">
      {found => (
        <b>
          {found.entries.map(e => e.content).join('|')}
          {found.failure !== null && ' (failed)'}
          {found.more && ' (more)'}
        </b>
      )}
    </Loaded>
  )

const inbox = (...adapters: InboxAdapter[]) =>
  inboxLoads(new ManualTime(0), adapters, DEFAULT_VIEW, () => true)

const down = () => Promise.reject(new ApiError('Busy', 503))

describe('the inbox list', () => {
  test('is loading until its sources answer, then shows their entries by time', async () => {
    const a = source('a', () => Promise.resolve({ entries: [entry('a', 1, 10)], next: null }))
    const b = source('b', () => Promise.resolve({ entries: [entry('b', 2, 20)], next: null }))
    const loads = inbox(a.adapter, b.adapter)
    expect(loads.list.get().status).toBe('loading')
    loads.start()
    expect(loads.list.get().status).toBe('loading')
    await settle()
    expect(draw(loads)).toBe('<b>note 2|note 1</b>')
    expect(loads.anyUnread.get()).toBe(true)
  })

  test('with nothing to show it is empty, and without a source too', async () => {
    const loads = inbox(source('a', () => Promise.resolve({ entries: [], next: null })).adapter)
    loads.start()
    await settle()
    expect(draw(loads)).toContain('caught up')
    expect(inbox().list.get().status).toBe('empty')
  })

  test('a source that fails with nothing to show is a refusal that can be asked again', async () => {
    let up = false
    const a = source('a', () =>
      up ? Promise.resolve({ entries: [entry('a', 1, 10)], next: null }) : down()
    )
    const loads = inbox(a.adapter)
    loads.start()
    await settle()
    expect(draw(loads)).toContain('Could not load notifications.')
    up = true
    loads.list.get().retry?.()
    await settle()
    expect(draw(loads)).toBe('<b>note 1</b>')
  })

  test('a source that never answered holds the list back, so nothing shows out of order', async () => {
    const a = source('a', () => Promise.resolve({ entries: [entry('a', 1, 10)], next: null }))
    const loads = inbox(a.adapter, source('b', down).adapter)
    loads.start()
    await settle()
    expect(loads.list.get().status).toBe('failed')
  })

  test('a later page that fails leaves the entries, with the failure beside them', async () => {
    const a = source('a', cursor =>
      cursor === null ? Promise.resolve({ entries: [entry('a', 1, 10)], next: 'p2' }) : down()
    )
    const loads = inbox(a.adapter)
    loads.start()
    await settle()
    expect(draw(loads)).toBe('<b>note 1 (more)</b>')
    loads.loadMore()
    await settle()
    expect(loads.list.get().status).toBe('ready')
    expect(draw(loads)).toBe('<b>note 1 (failed) (more)</b>')
  })

  test('pages that leave nothing to show are followed by the next ones', async () => {
    const asked: (string | null)[] = []
    const a = source('a', cursor => {
      asked.push(cursor)
      return Promise.resolve(
        cursor === null ? { entries: [], next: 'p2' } : { entries: [entry('a', 3, 30)], next: null }
      )
    })
    const loads = inbox(a.adapter)
    loads.start()
    await settle()
    expect(asked).toEqual([null, 'p2'])
    expect(draw(loads)).toBe('<b>note 3</b>')
  })

  test('reading an entry takes it off the unread list and marks it at its source', async () => {
    const one = entry('a', 1, 10)
    const a = source('a', () => Promise.resolve({ entries: [one, entry('a', 2, 5)], next: null }))
    const loads = inbox(a.adapter)
    loads.start()
    await settle()
    loads.read(one)
    expect(draw(loads)).toBe('<b>note 2</b>')
    expect(a.marked).toEqual([one.key])
    expect(loads.markedUntil()).toBeGreaterThan(0)
  })

  test('what arrives after it stopped is dropped', async () => {
    const a = source('a', () => Promise.resolve({ entries: [entry('a', 1, 10)], next: null }))
    const loads = inbox(a.adapter)
    const stop = loads.start()
    stop()
    await settle()
    expect(loads.list.get().status).toBe('loading')
  })
})

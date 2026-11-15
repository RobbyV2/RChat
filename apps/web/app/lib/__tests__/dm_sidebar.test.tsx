import { afterAll, afterEach, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { ChannelSidebar } from '../../components/channel_sidebar'
import type { DmListPrefs } from '../dm_list'
import { emptyLayout } from '../nav_layout'
import { resetSessionCaches, useStore } from '../store'
import type { RChatState } from '../store_types'
import type { DmSummary } from '../types'
import { me, user } from './fixtures'

const initial = useStore.getInitialState()
const saved = { ...initial }

// A static render reads the initial state through hooks and the current one outside them.
const seed = (state: Partial<RChatState>) => {
  Object.assign(initial, state)
  useStore.setState(state)
}

afterEach(() => seed({ ...saved }))

afterAll(resetSessionCaches)

const dm = (id: number, other: string, over: Partial<DmSummary> = {}): DmSummary => ({
  id,
  other: user(other),
  is_self: false,
  last_message_id: id,
  last_message_at: id,
  friend: false,
  ...over,
})

const LOADER = '<div class="h-px"></div>'
const NONE = 'No conversations match'

const sidebar = (list: Partial<DmListPrefs>, over: Partial<RChatState> = {}) => {
  const dms = [dm(1, 'alice', { is_self: true }), dm(2, 'bob'), dm(3, 'carol')]
  seed({
    token: 'tok',
    me: me('alice'),
    view: { kind: 'dm', dmId: 1 },
    dms,
    dmsMore: true,
    dmsEdge: { query: { sort: 'recent', friends: false }, last: dms[2] },
    readsReady: true,
    layout: {
      ...emptyLayout,
      dmPinned: [1],
      dmList: { sort: 'recent', friends: false, unread: false, unreadTop: false, ...list },
    },
    ...over,
  })
  return renderToStaticMarkup(<ChannelSidebar />)
}

test('the dm list ends in a loader while more pages remain', () => {
  const html = sidebar({})
  expect(html.split(LOADER)).toHaveLength(2)
  expect(html).not.toContain(NONE)
})

test('rows past the last paged row wait while more pages remain', () => {
  const paging = sidebar({})
  expect(paging).toContain('carol')
  expect(paging).not.toContain('bob')
  const done = sidebar({}, { dmsMore: false })
  expect(done).toContain('bob')
  expect(done).not.toContain(LOADER)
})

test('unread only with the whole unread list known asks for no page', () => {
  const html = sidebar({ unread: true })
  expect(html).not.toContain(LOADER)
  expect(html).toContain(NONE)
  expect(html).toContain('Clear filters')
})

test('unread only shows the unread dms it knows, without a loader', () => {
  const html = sidebar({ unread: true }, { reads: { d3: { lastRead: 1, latest: 3 } } })
  expect(html).not.toContain(LOADER)
  expect(html).not.toContain(NONE)
  expect(html).toContain('carol')
  expect(html).not.toContain('bob')
})

test('unread only keeps paging while the unread list is cut or not loaded', () => {
  const cut = sidebar({ unread: true }, { unreadsCut: true })
  expect(cut).toContain(LOADER)
  expect(cut).not.toContain(NONE)
  expect(sidebar({ unread: true }, { readsReady: false })).toContain(LOADER)
})

import { afterAll, afterEach, describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { ChannelSidebar, DmBlock } from '../../components/channel_sidebar'
import MemberSidebar from '../../components/member_sidebar'
import { MessagePane } from '../../components/message_pane'
import { SearchView } from '../../components/search_panel'
import { AccountServers } from '../../components/server_rail'
import ThreadPanel from '../../components/thread_panel'
import {
  ChannelListSkeleton,
  DmListSkeleton,
  Held,
  MemberListSkeleton,
  MessageListSkeleton,
  RowsSkeleton,
  ServerRailSkeleton,
} from '../../components/skeletons'
import type { SwitcherRow } from '../client/switcher_rows'
import { AccountProvider } from '../client/react'
import { resetSessionCaches, useStore } from '../store'
import type { RChatState } from '../store_types'
import { me, member, msg, paged, serverDetail, textChannel } from './fixtures'
import { testAccount } from './test_account'
import { Secret } from '../secret'

// Markup renders with the store's initial state.
const initial = useStore.getInitialState()
const saved = { ...initial }
const put = (state: Partial<RChatState>) => {
  Object.assign(initial, state)
  useStore.setState(state)
}
afterEach(() => put({ ...saved }))
afterAll(resetSessionCaches)

const KINDS = [
  ['messages', 'Loading messages', <MessageListSkeleton key="m" seed="c1" />],
  ['members', 'Loading members', <MemberListSkeleton key="u" seed="club" />],
  ['channels', 'Loading channels', <ChannelListSkeleton key="c" seed="club" header />],
  ['dms', 'Loading conversations', <DmListSkeleton key="d" seed="alice" />],
  ['servers', 'Loading servers', <ServerRailSkeleton key="s" seed="alice" />],
  ['rows', 'Loading friends', <RowsSkeleton key="r" rows={2} label="Loading friends" />],
] as const

const count = (html: string, part: string) => html.split(part).length - 1

describe('skeleton placeholders', () => {
  test('each is a busy status with its label and kind, the same on every render', () => {
    for (const [kind, label, node] of KINDS) {
      const html = renderToStaticMarkup(node)
      expect(html).toContain('role="status"')
      expect(html).toContain('aria-busy="true"')
      expect(html).toContain(`aria-label="${label}"`)
      expect(html).toContain(`data-skeleton="${kind}"`)
      expect(count(html, 'data-skeleton=')).toBe(1)
      expect(html).toContain('data-blob')
      expect(renderToStaticMarkup(node)).toBe(html)
    }
  })

  test('the blobs hold their place with animations off or Motion at Reduced, and shimmer when on', () => {
    for (const [, , node] of KINDS) {
      expect(renderToStaticMarkup(node)).not.toContain('data-shimmer')
      initial.anim = { on: true, motion: 'still' }
      expect(renderToStaticMarkup(node)).not.toContain('data-shimmer')
      initial.anim = { on: true, motion: 'always' }
      expect(renderToStaticMarkup(node)).toContain('data-shimmer')
      initial.anim = saved.anim
    }
    expect(renderToStaticMarkup(<RowsSkeleton rows={2} label="Loading" />)).not.toContain(
      'animate-pulse'
    )
  })

  test('different keys draw different messages, and search hits have no cards', () => {
    const a = renderToStaticMarkup(<MessageListSkeleton seed="c1" />)
    expect(renderToStaticMarkup(<MessageListSkeleton seed="c2" />)).not.toBe(a)
    for (let i = 0; i < 20; i += 1)
      expect(
        renderToStaticMarkup(<MessageListSkeleton seed={`s${i}`} variant="search" />)
      ).not.toContain('rounded-xl')
  })

  test('blobs are tinted from the text color, so they show on every surface and theme', () => {
    for (const [, , node] of KINDS) {
      const html = renderToStaticMarkup(node)
      expect(html).toContain('bg-on-surface/')
      expect(html).not.toContain('surface-container-highest')
    }
  })

  test('a held placeholder renders hidden at first', () => {
    const html = renderToStaticMarkup(
      <Held>
        <DmListSkeleton seed="p2p" rows={3} />
      </Held>
    )
    expect(html.startsWith('<div hidden="" class="contents">')).toBe(true)
    expect(html).toContain('data-skeleton="dms"')
  })

  test('section rows keep their label and draw the rows asked for', () => {
    const html = renderToStaticMarkup(<RowsSkeleton rows={3} label="Loading notifications" />)
    expect(html).toContain('aria-label="Loading notifications"')
    expect(html).toContain('data-skeleton="rows"')
    expect(count(html, 'size-8 shrink-0 rounded-full')).toBe(3)
  })
})

describe('where skeletons show', () => {
  const channelView = { kind: 'channel' as const, server: 'club', channelId: 1 }
  const club = serverDetail('club', { channels: [textChannel(1)], member_count: 3 })
  const signedIn = { token: Secret.of('tok'), me: me('alice'), guest: false }

  test('a channel list loads with placeholders until the server arrives', () => {
    put({ ...signedIn, view: channelView, servers: {} })
    expect(renderToStaticMarkup(<ChannelSidebar />)).toContain('data-skeleton="channels"')
    put({ servers: { club } })
    expect(renderToStaticMarkup(<ChannelSidebar />)).not.toContain('data-skeleton')
  })

  test('the member list loads with placeholders until its first page lands', () => {
    put({ ...signedIn, view: channelView, servers: {}, members: {} })
    expect(renderToStaticMarkup(<MemberSidebar />)).toContain('data-skeleton="members"')
    put({ servers: { club } })
    expect(renderToStaticMarkup(<MemberSidebar />)).toContain('data-skeleton="members"')
    put({ members: { club: { list: [], hasMore: true, loading: true, q: '' } } })
    expect(renderToStaticMarkup(<MemberSidebar />)).toContain('data-skeleton="members"')
    put({ members: { club: paged([member('bob', { online: true })]) } })
    const html = renderToStaticMarkup(<MemberSidebar />)
    expect(html).not.toContain('data-skeleton')
    expect(html).toContain('Online (')
    put({ servers: { club: { ...club, member_count: 0 } }, members: {} })
    expect(renderToStaticMarkup(<MemberSidebar />)).not.toContain('data-skeleton')
  })

  test('messages load with placeholders over a hidden list, and an empty channel says so', () => {
    put({ ...signedIn, view: channelView, servers: { club }, messages: {}, stale: { c1: true } })
    const loading = renderToStaticMarkup(<MessagePane onMenu={() => {}} onMembers={() => {}} />)
    expect(loading).toContain('data-skeleton="messages"')
    expect(loading).toContain('overflow-y-auto py-3 invisible')
    put({ messages: { c1: [] }, stale: {} })
    const empty = renderToStaticMarkup(<MessagePane onMenu={() => {}} onMembers={() => {}} />)
    expect(empty).not.toContain('data-skeleton')
    expect(empty).toContain('No messages here yet')
    put({ messages: { c1: [msg(5, { channel_id: 1 })] }, stale: { c1: true } })
    const cached = renderToStaticMarkup(<MessagePane onMenu={() => {}} onMembers={() => {}} />)
    expect(cached).toContain('data-skeleton="messages"')
    expect(cached).toContain('overflow-y-auto py-3 invisible')
  })

  test('a thread with replies loads them under placeholders, one without replies does not', () => {
    const root = msg(5, { channel_id: 1, reply_count: 3 })
    put({
      ...signedIn,
      view: channelView,
      servers: { club },
      messages: { c1: [root] },
      panel: { kind: 'thread', root },
      stale: { t5: true },
    })
    const loading = renderToStaticMarkup(<ThreadPanel />)
    expect(loading).toContain('data-skeleton="messages"')
    expect(loading).toContain('aria-label="Loading replies"')
    const none = { ...root, reply_count: 0 }
    put({ messages: { c1: [none] }, panel: { kind: 'thread', root: none } })
    expect(renderToStaticMarkup(<ThreadPanel />)).not.toContain('data-skeleton')
    put({ messages: { c1: [root], t5: [] }, panel: { kind: 'thread', root }, stale: {} })
    expect(renderToStaticMarkup(<ThreadPanel />)).not.toContain('data-skeleton')
  })

  test('search shows placeholders while nothing is found yet', () => {
    const view = (loading: boolean, q = 'deploy') =>
      renderToStaticMarkup(
        <SearchView
          channels={undefined}
          hits={[]}
          loading={loading}
          hasMore
          pageKey="0:"
          seed={{ q, n: 0 }}
          onRun={() => {}}
          onClose={() => {}}
        />
      )
    const busy = view(true)
    expect(busy).toContain('data-skeleton="messages"')
    expect(busy).toContain('aria-label="Loading results"')
    expect(busy).not.toContain('>Searching<')
    expect(view(false)).not.toContain('data-skeleton')
    expect(view(true, '')).not.toContain('data-skeleton')
  })
})

describe('accounts that are starting in the background', () => {
  const row = (status: SwitcherRow['status']): SwitcherRow => ({
    origin: 'https://b.test',
    username: 'bob',
    local: null,
    saved: true,
    display: 'bob',
    status,
    badge: 0,
    unread: false,
    active: false,
    avatar: null,
    ik: null,
    background: true,
  })
  const starting = (bootError: string | null) => {
    const b = testAccount('bob', 'https://b.test')
    Object.assign(b.store.getInitialState(), { me: null, bootError })
    return b
  }

  test('the rail shows placeholder tiles while connecting, and the resume tile once boot fails', () => {
    const rail = (bootError: string | null, status: SwitcherRow['status']) => {
      const b = starting(bootError)
      try {
        return renderToStaticMarkup(
          <AccountProvider session={b}>
            <AccountServers row={row(status)} />
          </AccountProvider>
        )
      } finally {
        b.store.dispose()
      }
    }
    const connecting = rail(null, 'Connecting')
    expect(connecting).toContain('data-skeleton="servers"')
    expect(connecting).not.toContain('Show bob on b.test')
    for (const html of [rail('Network error', 'Connecting'), rail(null, 'Paused')]) {
      expect(html).not.toContain('data-skeleton')
      expect(html).toContain('aria-label="Show bob on b.test"')
    }
  })

  test('the DM list shows placeholders while connecting, and nothing once boot fails', () => {
    const dms = (bootError: string | null, connecting: boolean) => {
      const b = starting(bootError)
      try {
        return renderToStaticMarkup(
          <AccountProvider session={b}>
            <DmBlock dmId={-1} accounts={[b]} connecting={connecting} label="bob · b" />
          </AccountProvider>
        )
      } finally {
        b.store.dispose()
      }
    }
    const loading = dms(null, true)
    expect(loading).toContain('data-skeleton="dms"')
    expect(loading).toContain('aria-label="Loading direct messages"')
    expect(dms('Network error', true)).not.toContain('data-skeleton')
    expect(dms(null, false)).not.toContain('data-skeleton')
  })
})

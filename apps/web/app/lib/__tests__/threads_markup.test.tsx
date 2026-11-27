import { afterEach, describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { useStore } from '../store'
import { ThreadsButton, ThreadsPanel, type useThreadPages } from '../../components/threads'
import type { ThreadRow } from '../thread_list'
import { me, msg, user } from './fixtures'

// Server rendering reads the store's initial state, so the test state goes there too.
const initial = useStore.getInitialState()
const saved = { ...initial }
const setBoth = (part: Partial<typeof initial>) => {
  Object.assign(initial, part)
  useStore.setState(part)
}

afterEach(() => {
  Object.assign(initial, saved)
  useStore.setState(saved)
})

const row = (id: number, over: Partial<ThreadRow> = {}): ThreadRow => ({
  key: String(id),
  root: msg(id, { content: `**Topic** ${id}`, dm_id: 4, channel_id: null, author: user('alice') }),
  files: false,
  replies: 2,
  lastAt: 100,
  pinged: false,
  ...over,
})

const list = (
  rows: ThreadRow[] | null,
  over: Partial<ReturnType<typeof useThreadPages>> = {}
): ReturnType<typeof useThreadPages> => ({
  query: '',
  search: () => {},
  rows,
  next: null,
  failed: false,
  more: () => {},
  retry: () => {},
  ...over,
})

const panel = (l: ReturnType<typeof useThreadPages>, selfDm = false) =>
  renderToStaticMarkup(
    <ThreadsPanel
      list={l}
      selfDm={selfDm}
      server={null}
      onClose={() => {}}
      onOpen={() => {}}
      onJump={() => {}}
    />
  )

describe('the Threads list', () => {
  test('rows show the author, the first line, the replies and a dot for unread mentions', () => {
    setBoth({ me: me('bob') })
    const html = panel(list([row(7, { pinged: true }), row(8, { replies: 1 })]))
    expect(html).toContain('placeholder="Search threads"')
    expect(html.match(/data-thread-row=/g)?.length).toBe(2)
    expect(html).toContain('Topic 7')
    expect(html).not.toContain('**')
    expect(html).toContain('2 replies')
    expect(html).toContain('1 reply')
    expect(html.match(/data-thread-pinged/g)?.length).toBe(1)
    expect(html).toContain('aria-label="Unread mentions"')
    expect(/class="streamer[^"]*"/.test(html)).toBe(true)
    expect(html).not.toContain('—')
  })

  test('a blocked author shows no text, and a root without text says what it holds', () => {
    setBoth({ me: me('bob'), blocked: { carol: true } })
    const blocked = row(9, { root: msg(9, { content: 'secret', author: user('carol') }) })
    const file = row(10, { root: msg(10, { content: '' }), files: true })
    const html = panel(list([blocked, file]))
    expect(html).toContain('Blocked message')
    expect(html).not.toContain('secret')
    expect(html).toContain('Attachment')
  })

  test('empty: no threads yet, in the DM with yourself, and no match', () => {
    setBoth({ me: me('bob') })
    expect(panel(list([]))).toContain('There are no threads')
    expect(panel(list([]))).toContain('Stay focused on a conversation with a thread.')
    expect(panel(list([]), true)).toContain('Organize notes and forwarded messages')
    const searched = panel(list([], { query: 'zz' }))
    expect(searched).toContain('No matching threads')
    expect(searched).toContain('aria-label="Clear search"')
    expect(panel(list(null))).toContain('Loading threads')
    expect(panel(list(null, { failed: true }))).toContain('Retry')
  })

  test('the header button is named and says whether its list is open', () => {
    const closed = renderToStaticMarkup(
      <ThreadsButton toggle={{ open: false, onClick: () => {} }} />
    )
    expect(closed).toContain('title="Threads"')
    expect(closed).toContain('aria-label="Threads"')
    expect(closed).toContain('aria-expanded="false"')
    const open = renderToStaticMarkup(<ThreadsButton toggle={{ open: true, onClick: () => {} }} />)
    expect(open).toContain('aria-expanded="true"')
  })
})

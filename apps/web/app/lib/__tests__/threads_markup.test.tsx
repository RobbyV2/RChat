import { afterEach, describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { useStore } from '../store'
import { ThreadsPanel, type useThreadPages } from '../../components/threads'
import type { ThreadRow } from '../thread_list'
import { ApiError } from '../api'
import type { Pages } from '../load'
import { loadOf, pagesOf } from './helpers/loads'
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

type List = ReturnType<typeof useThreadPages>

const list = (rows: ThreadRow[], over: Partial<List> = {}): List => ({
  query: '',
  search: () => {},
  pages: loadOf<Pages<ThreadRow>>(make => (rows.length ? make.ready(pagesOf(rows)) : make.empty())),
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
    expect(panel(list([], { pages: loadOf(make => make.loading()) }))).toContain(
      'aria-label="Loading threads"'
    )
    const failed = panel(
      list([], {
        pages: loadOf(
          make => make.failed(new ApiError('Busy', 503)),
          () => {}
        ),
      })
    )
    expect(failed).toContain('Could not load threads.')
    expect(failed).toContain('Try again')
  })
})

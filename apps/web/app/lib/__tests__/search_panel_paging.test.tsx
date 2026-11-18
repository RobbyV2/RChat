import { afterAll, describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { endOfList, shortSearch } from '../search'
import { resetSessionCaches } from '../store'
import { SearchView } from '../../components/search_panel'

afterAll(resetSessionCaches)

const OLDER = 'Search older messages'

const view = (
  q: string,
  { loading = false, hasMore = true }: { loading?: boolean; hasMore?: boolean } = {},
  scrollForMore: ((q: string) => boolean) | null = shortSearch
) =>
  renderToStaticMarkup(
    <SearchView
      channels={undefined}
      hits={[]}
      loading={loading}
      hasMore={hasMore}
      pageKey="0:a"
      seed={{ q, n: 0 }}
      scrollForMore={scrollForMore ?? undefined}
      onRun={() => {}}
      onClose={() => {}}
    />
  )

describe('search panel paging', () => {
  test('an empty page shows no final message while it has a continuation', () => {
    expect(view('meeting notes', { hasMore: true })).not.toContain('No results.')
    expect(view('meeting notes', { hasMore: false })).toContain('No results.')
  })

  test('short text offers older messages at the end of the list', () => {
    const offer = new RegExp(`<button[^>]*cursor-pointer[^>]*>${OLDER}</button>`)
    expect(offer.test(view('we'))).toBe(true)
  })

  test('no offer while a page loads, after the last page, for longer text, or where pages load on sight', () => {
    expect(view('we', { loading: true })).not.toContain(OLDER)
    expect(view('we', { hasMore: false })).not.toContain(OLDER)
    expect(view('weekly')).not.toContain(OLDER)
    expect(view('we', {}, null)).not.toContain(OLDER)
  })
})

describe('end of the search list', () => {
  test('the list has no scroll anchoring, so a page that lands never scrolls it toward the end', () => {
    const list = /class="[^"]*overflow-y-auto[^"]*\[overflow-anchor:none\]/
    expect(list.test(view('we'))).toBe(true)
  })

  test('the end of the list clears the bottom safe area of a home-screen app', () => {
    const list =
      /class="[^"]*overflow-y-auto[^"]*pb-\[max\(0\.5rem,env\(safe-area-inset-bottom\)\)\]/
    expect(list.test(view('we'))).toBe(true)
  })

  test('for short text the end of the list keeps its height while a page loads', () => {
    const footer = (html: string) =>
      /<div class="([^"]*)"><(?:button|p)[^>]*>(Search older messages|Searching)</.exec(html)
    const idle = footer(view('we'))
    const busy = footer(view('we', { loading: true }))
    expect(idle?.[2]).toBe('Search older messages')
    expect(busy?.[2]).toBe('Searching')
    expect(/\bh-\d+\b/.test(idle?.[1] ?? '')).toBe(true)
    expect(busy?.[1]).toBe(idle?.[1] ?? '')
  })

  test('for short text a page whose end shows at once loads nothing until the member scrolls', () => {
    const end = endOfList()
    expect(end.sight(true, 'p0', true)).toBe(false)
    expect(end.scroll(40, 'p0', true)).toBe(true)
    expect(end.sight(true, 'p1', true)).toBe(false)
  })

  test('for short text one scroll loads at most one page', () => {
    const end = endOfList()
    expect(end.sight(false, 'p0', true)).toBe(false)
    expect(end.scroll(1400, 'p0', true)).toBe(false)
    expect(end.sight(true, 'p0', true)).toBe(true)
    expect(end.sight(true, 'p0', true)).toBe(false)
    expect(end.scroll(1410, 'p0', true)).toBe(false)
    for (const page of ['p1', 'p1', 'p1']) expect(end.sight(true, page, true)).toBe(false)
  })

  test('for short text each later page needs another scroll toward the end', () => {
    const end = endOfList()
    end.sight(false, 'p0', true)
    end.scroll(1400, 'p0', true)
    expect(end.sight(true, 'p0', true)).toBe(true)
    expect(end.sight(true, 'p1', true)).toBe(false)
    expect(end.scroll(1396, 'p1', true)).toBe(false)
    expect(end.scroll(1300, 'p1', true)).toBe(false)
    expect(end.scroll(1400, 'p1', true)).toBe(true)
    expect(end.scroll(1404, 'p1', true)).toBe(false)
    expect(end.sight(true, 'p2', true)).toBe(false)
    expect(end.sight(false, 'p2', true)).toBe(false)
    expect(end.scroll(1500, 'p2', true)).toBe(false)
    expect(end.sight(true, 'p2', true)).toBe(true)
    expect(end.sight(true, 'p3', true)).toBe(false)
  })

  test('longer text loads the next page whenever the end comes into view', () => {
    const end = endOfList()
    expect(end.sight(true, 'p0', false)).toBe(true)
    expect(end.sight(true, 'p1', false)).toBe(true)
    expect(end.sight(true, 'p1', false)).toBe(true)
    expect(end.scroll(400, 'p1', false)).toBe(false)
  })
})

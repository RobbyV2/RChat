import { ApiError, type SearchParams } from './api'
import { appendUnique } from './lists'
import { charCount } from './rules'
import type { SearchResult } from './types'

export const SEARCH_PAGE = 25

// The longest wait, in seconds, a search sits out before it asks again.
export const SEARCH_RETRY_MAX = 5

// Seconds to wait before asking again when the server refused a search for the caller's own
// limits (429, reason `rate`) with a wait of at most `SEARCH_RETRY_MAX`; null otherwise.
export const searchRetryAfter = (e: unknown): number | null => {
  if (!(e instanceof ApiError) || e.status !== 429) return null
  const data = e.data as { reason?: { kind?: unknown; retry_after?: unknown } } | undefined
  const wait = data?.reason?.retry_after
  const short = typeof wait === 'number' && wait > 0 && wait <= SEARCH_RETRY_MAX
  return data?.reason?.kind === 'rate' && short ? wait : null
}

export interface SearchArgs {
  q: string
  from: string
  channelId: number | null
  hasFile: boolean
  beforeTs: number | null
  afterTs: number | null
}

export const sameSearch = (a: SearchArgs, b: SearchArgs | null): boolean =>
  b !== null &&
  a.q === b.q &&
  a.from === b.from &&
  a.channelId === b.channelId &&
  a.hasFile === b.hasFile &&
  a.beforeTs === b.beforeTs &&
  a.afterTs === b.afterTs

const localDay = (date: string, offset: number): number | null => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date)
  if (!m) return null
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]) + offset).getTime() / 1000
}

export const dayStartTs = (date: string): number | null => localDay(date, 0)

export const dayEndTs = (date: string): number | null => {
  const next = localDay(date, 1)
  return next === null ? null : next - 1
}

export const searchParams = (
  args: SearchArgs,
  cursor: string | null,
  servers: string[] | null
): SearchParams => ({
  q: args.q || undefined,
  from: args.from || undefined,
  channel_id: args.channelId ?? undefined,
  has: args.hasFile ? 'file' : undefined,
  cursor: cursor ?? undefined,
  before_ts: args.beforeTs ?? undefined,
  after_ts: args.afterTs ?? undefined,
  servers: servers ?? undefined,
})

export const SEARCH_MAX = 500
export const SEARCH_TRIES = 4

// Text shorter than this, in characters as the server counts them, is searched without the
// full-text index.
export const SEARCH_SHORT = 3

export const shortSearch = (q: string): boolean => charCount(q.trim()) < SEARCH_SHORT

// Pages one search run reads to fill a page of results: one for short text, whose further
// pages load as the member scrolls to the end, `SEARCH_TRIES` otherwise.
export const searchTries = (q: string): number => (shortSearch(q) ? 1 : SEARCH_TRIES)

// When the end of a search list asks for the next page. `page` changes with every page. Text
// read a page at a time (`stepped`) asks only after the member scrolled toward the end since
// that page arrived, with the end in view, and once a page at most; other text asks whenever
// the end comes into view.
export interface EndOfList {
  // The end came into view (`visible`) or left it; whether to ask now.
  sight: (visible: boolean, page: string, stepped: boolean) => boolean
  // The list scrolled to `top`; whether to ask now. Only the member moves `top` toward the end:
  // the list has no scroll anchoring.
  scroll: (top: number, page: string, stepped: boolean) => boolean
}

export const endOfList = (): EndOfList => {
  let top = 0
  let shownOn: string | null = null
  let scrolledOn: string | null = null
  let askedOn: string | null = null
  const ask = (page: string) => {
    if (scrolledOn !== page || askedOn === page) return false
    askedOn = page
    return true
  }
  return {
    sight: (visible, page, stepped) => {
      shownOn = visible ? page : null
      return visible && (!stepped || ask(page))
    },
    scroll: (to, page, stepped) => {
      const down = to > top
      top = to
      if (down) scrolledOn = page
      return stepped && down && shownOn === page && ask(page)
    },
  }
}

export const addSearchPage = (
  results: SearchResult[],
  page: SearchResult[],
  next: string | null,
  max = SEARCH_MAX
): { results: SearchResult[]; hasMore: boolean } => {
  const all = appendUnique(results, page, r => r.message.id)
  const capped = all.length > max ? all.slice(0, max) : all
  return { results: capped, hasMore: next !== null && capped.length < max }
}

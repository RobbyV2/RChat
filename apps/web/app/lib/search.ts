import type { SearchParams } from './api'
import { appendUnique } from './lists'
import type { SearchResult } from './types'

export const SEARCH_PAGE = 25

export interface SearchArgs {
  q: string
  from: string
  channelId: number | null
  hasFile: boolean
  beforeTs: number | null
  afterTs: number | null
}

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

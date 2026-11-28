import type { AccountSession } from '../client/session'
import type { P2pApp } from '../p2p/app/runtime'
import type { MemberView } from '../p2p/server'
import { ownsP2pServer } from '../p2p/server/types'
import { shortSearch, type SearchArgs } from '../search'
import type { Message, SearchResult, UserRef } from '../types'
import type { ViewingTarget } from '../viewing'
import { defineFeature } from './feature'
import { fromLive, type Load, type LoadMaker } from '../load'
import { time } from '../platform/time'
import { built, type Live } from './live'

// The filters as typed; `channel` is a channel id ('' for any).
export interface SearchFilters {
  q: string
  from: string
  channel: string
  hasFile: boolean
  beforeTs: number | null
  afterTs: number | null
}

// A result of the search panel, whichever side found it: where it is, who wrote it and what.
export interface SearchHit {
  key: string
  channel: string
  server: string
  // The channel and server names are your own text.
  ownPlace: boolean
  // An account opens its profile card in `server`; a key shows the picture and name its room
  // has for it; null for a hit whose room is closed here.
  author:
    | { kind: 'account'; user: UserRef; server: string }
    | { kind: 'key'; ik: string; name: string; of: readonly MemberView[] | undefined }
    | null
  createdAt: number
  content: string
  // Your own message: its text and file name are never masked for you.
  own: boolean
  forwarded: boolean
  // The attachment's label, or null without one.
  file: string | null
  fileSpoiler?: boolean
  // A forwarded instance copy, shown only when its source room is open here.
  copy?: { message: Pick<Message, 'forward' | 'channel_id'>; server: string }
  // A hit from a room closed here: the room to ask about before showing it.
  reveal?: ViewingTarget
  onOpen: () => void
}

export interface SearchState {
  // The "in:" choices (the place's channels), or none.
  channels: { id: string; name: string }[] | undefined
  hits: SearchHit[]
  loading: boolean
  hasMore: boolean
  // Changes with every page, so the next one loads when the end shows again.
  pageKey: string
  // A query to start with; a new `n` puts its text in the field again.
  seed: { q: string | null; n: number } | null
  // Shown under the filters (where the search looks).
  note: string | null
  // Whether the search is an identity's (over what this device stores) and not an account's.
  byIdentity: boolean
  // What the last page failed with (null: nothing); the page can be asked for again.
  failure: unknown
}

export interface Search {
  state: Live<SearchState>
  // The results as a load: loading until the first page is here, refused when it did not come,
  // empty when nothing matches. A later page that fails leaves the hits with `failure` beside
  // them. Asking again runs the last search afresh.
  results: Live<Load<SearchState>>
  // A first page (`fresh`) or the next one.
  run: (f: SearchFilters, fresh: boolean) => void
  close: () => void
  // Whether, for this text, the next page loads only when asked for or scrolled to, not as soon
  // as the end shows.
  steps: (q: string) => boolean
  // Keeps what the results need loaded; the answer stops it.
  watch: () => () => void
}

// What a search shows for its state: the hits once there are some (a search that found none yet
// and can go on counts, so its way to older messages shows), else that it is loading, refused or
// without a match.
export const searchLoad = (s: SearchState, make: LoadMaker<SearchState>): Load<SearchState> => {
  if (s.hits.length > 0) return make.ready(s)
  if (s.failure !== null) return make.failed(s.failure)
  if (s.loading) return make.loading()
  return s.hasMore ? make.ready(s) : make.empty()
}

// A search with its results as a load. Asking again runs the last filters afresh.
const withResults = (search: Omit<Search, 'results'>): Search => {
  let last: SearchFilters | null = null
  return {
    ...search,
    run: (f, fresh) => {
      last = f
      search.run(f, fresh)
    },
    results: fromLive(time(), search.state, searchLoad, () => {
      if (last) search.run(last, true)
    }),
  }
}

const hosted = (account: AccountSession, server: string | null): Search => {
  const { store, viewing } = account
  const { useViewing, canView, instanceTarget } = viewing
  const parts = (initial: boolean) => () => {
    const s = initial ? store.getInitialState() : store.getState()
    return [
      s.search,
      server === null ? undefined : s.servers[server]?.channels,
      s.me?.username ?? null,
      s.me?.servers,
      s.servers,
      useViewing.getState().revision,
    ] as const
  }
  const state = (initial: boolean) =>
    built(parts(initial), ([search, channels, me, mine]): SearchState => {
      const owns = (name: string) => me !== null && mine?.find(x => x.name === name)?.creator === me
      const open = (r: SearchResult) => () => void store.getState().openResult(r)
      return {
        channels: channels?.map(c => ({ id: String(c.id), name: c.name })),
        hits: search.results.map((r): SearchHit => {
          const t = instanceTarget(store.getState(), r.server, r.message.channel_id ?? -1)
          if (!t || !canView(t))
            return {
              key: String(r.message.id),
              channel: r.channel_name,
              server: r.server,
              ownPlace: false,
              author: null,
              createdAt: r.message.created_at,
              content: '',
              own: false,
              forwarded: false,
              file: null,
              ...(t ? { reveal: t } : {}),
              onOpen: open(r),
            }
          return {
            key: String(r.message.id),
            channel: r.channel_name,
            server: r.server,
            ownPlace: owns(r.server),
            author: { kind: 'account', user: r.message.author, server: r.server },
            createdAt: r.message.created_at,
            content: r.message.content,
            own: !r.message.webhook && r.message.author.username === me,
            forwarded: !!r.message.forward,
            file: r.message.media?.filename ?? null,
            fileSpoiler: r.message.media?.spoiler,
            ...(r.message.forward ? { copy: { message: r.message, server: r.server } } : {}),
            onOpen: open(r),
          }
        }),
        loading: search.loading,
        hasMore: search.hasMore,
        pageKey: `${search.results.length}:${search.cursor ?? ''}`,
        seed: { q: search.seed ?? null, n: search.seedN ?? 0 },
        note: null,
        byIdentity: false,
        failure: search.failed ?? null,
      }
    })
  return withResults({
    state: {
      get: state(false),
      initial: state(true),
      subscribe: changed => {
        const stops = [store.subscribe(changed), useViewing.subscribe(changed)]
        return () => stops.forEach(stop => stop())
      },
    },
    run: (f, fresh) =>
      void store.getState().searchRun(
        {
          q: f.q,
          from: f.from,
          channelId: f.channel ? Number(f.channel) : null,
          hasFile: f.hasFile,
          beforeTs: f.beforeTs,
          afterTs: f.afterTs,
        } satisfies SearchArgs,
        fresh
      ),
    close: () => store.getState().closePanel(),
    steps: shortSearch,
    // The servers of the results are looked up, so their channels can be opened and asked about.
    watch: () => {
      let seen: unknown = null
      let asked = new Set<string>()
      const run = () => {
        const s = store.getState()
        if (s.search.results !== seen) {
          seen = s.search.results
          asked = new Set()
        }
        for (const r of s.search.results) {
          if (s.servers[r.server] || asked.has(r.server)) continue
          asked.add(r.server)
          void s.discoverChannels(r.server).catch(() => {})
        }
      }
      run()
      return store.subscribe(run)
    },
  })
}

const peer = (app: P2pApp, room: string | null): Search => {
  const { useP2p, memberName, p2pSearch } = app
  const parts = (initial: boolean) => () => {
    const s = initial ? useP2p.getInitialState() : useP2p.getState()
    return [s.search, s.servers, s.me] as const
  }
  const state = (initial: boolean) =>
    built(parts(initial), ([search, servers, me]): SearchState => ({
      channels: room === null ? undefined : servers[room]?.channels.filter(c => c.kind === 'text'),
      hits: search.hits.map((h): SearchHit => {
        const v = servers[h.room]
        const att = h.m.fwd?.att ?? h.m.att
        return {
          key: h.m.id,
          channel: v?.channels.find(c => c.id === h.ch)?.name ?? '',
          server: v?.name ?? 'P2P server',
          ownPlace: ownsP2pServer(v, me),
          author: {
            kind: 'key',
            ik: h.m.sender,
            name: memberName(h.room, h.m.sender),
            of: v?.members,
          },
          createdAt: Math.floor(h.m.ts / 1000),
          content: h.m.fwd ? h.m.fwd.body : h.m.body,
          own: h.m.sender === me,
          forwarded: !!h.m.fwd,
          file: att[0]?.name ?? null,
          fileSpoiler: att[0]?.spoiler,
          onOpen: () => void p2pSearch.openHit(h),
        }
      }),
      loading: search.loading,
      hasMore: search.next !== null,
      pageKey: `${search.hits.length}:${search.next ?? ''}`,
      seed: null,
      note: search.indexing
        ? 'Searches messages stored on this device. Still indexing, so some may be missing.'
        : 'Searches messages stored on this device',
      byIdentity: true,
      failure: search.failed ?? null,
    }))
  return withResults({
    state: {
      get: state(false),
      initial: state(true),
      subscribe: changed => useP2p.subscribe(changed),
    },
    run: (f, fresh) =>
      void p2pSearch.run(
        {
          q: f.q,
          from: f.from,
          ch: f.channel || null,
          hasFile: f.hasFile,
          beforeTs: f.beforeTs,
          afterTs: f.afterTs,
        },
        fresh
      ),
    close: () => p2pSearch.close(),
    steps: () => false,
    watch: () => () => {},
  })
}

// Search from a place: an account searches its instance, an identity what its device stores.
export const search = defineFeature<Search>('search', {
  hostedServer: place => hosted(place.account, place.server),
  p2pRoom: place => peer(place.app, place.room),
  hostedDm: place => hosted(place.account, null),
  p2pDm: place => peer(place.app, null),
})

const own = new WeakMap<AccountSession, Search>()

// The account's search of its instance, for a panel open outside any place.
export const accountSearch = (account: AccountSession): Search => {
  let known = own.get(account)
  if (!known) {
    known = hosted(account, null)
    own.set(account, known)
  }
  return known
}

import type { Time } from './clock'
import {
  OWN_MARK_MS,
  allRead,
  freshSource,
  hasMore,
  markedRead,
  mergeEntries,
  refreshHead,
  sourcesToLoad,
  type InboxAdapter,
  type InboxEntry,
  type InboxView,
  type SourceState,
} from './inbox'
import { fromLive, type Load } from './load'
import type { Live } from './place/live'

// The inbox on screen: the entries of every source merged by time, whether older ones can be
// asked for, and what the last page of a source failed with (null: nothing).
export interface InboxList {
  entries: InboxEntry[]
  more: boolean
  loadingMore: boolean
  failure: unknown
}

export interface InboxLoads {
  // Loading until a source has entries to show, refused when none came, empty when there are
  // none. A source that fails beside entries leaves them with `failure`.
  list: Live<Load<InboxList>>
  anyUnread: Live<boolean>
  adapterOf(id: string): InboxAdapter | undefined
  // Starts loading; the answer stops it, and what arrives afterwards is dropped.
  start(): () => void
  // Fetches every source's first page again and merges it in front of what is loaded.
  reload(): void
  loadMore(): void
  open(entry: InboxEntry, onClose?: (jumped: boolean) => void): void
  read(entry: InboxEntry): void
  readAll(): void
  // Until when a lower badge count is this list's own doing.
  markedUntil(): number
}

// The inbox for `view` from every source in `adapters`. `current` says whether these sources
// are still the ones in use.
export const inboxLoads = (
  time: Time,
  adapters: InboxAdapter[],
  view: InboxView,
  current: () => boolean
): InboxLoads => {
  let sources: Record<string, SourceState> = Object.fromEntries(
    adapters.map(a => [a.id, freshSource()])
  )
  let shown: InboxList = {
    entries: [],
    more: hasMore(sources),
    loadingMore: false,
    failure: null,
  }
  let failure: unknown = null
  let generation = 0
  let running = false
  let markedUntil = 0
  const heard = new Set<() => void>()
  const live = () => running && current()
  const put = (next: Record<string, SourceState>) => {
    sources = next
    const states = Object.values(sources)
    if (!states.some(s => s.failed)) failure = null
    shown = {
      entries: mergeEntries(sources),
      more: hasMore(sources),
      loadingMore: states.some(s => s.loading),
      failure: states.some(s => s.failed) ? failure : null,
    }
    for (const changed of [...heard]) changed()
  }
  const change = (id: string, to: (prev: SourceState) => SourceState) =>
    put({ ...sources, [id]: to(sources[id] ?? freshSource()) })
  const adapterOf = (id: string) => adapters.find(a => a.id === id)

  const fetchPage = (id: string, cursor: string | null, at: number) => {
    const adapter = adapterOf(id)
    if (!adapter) return
    change(id, prev => ({ ...prev, loading: true }))
    adapter.load(view, cursor).then(
      page => {
        if (!live() || generation !== at) return
        change(id, prev => {
          if (cursor === null) return refreshHead(prev, page)
          const seen = new Set(prev.entries.map(e => e.key))
          return {
            entries: [...prev.entries, ...page.entries.filter(e => !seen.has(e.key))],
            next: page.next,
            done: page.next === null,
            loading: false,
            failed: false,
          }
        })
        // Pages that leave nothing to show yet are followed by the next ones.
        if (shown.entries.length === 0 && shown.more && !shown.loadingMore) loadMore()
      },
      (error: unknown) => {
        if (!live() || generation !== at) return
        failure = error
        change(id, prev => ({ ...prev, loading: false, failed: true }))
      }
    )
  }

  const reload = () => {
    if (!live()) return
    generation += 1
    for (const a of adapters) fetchPage(a.id, null, generation)
  }

  function loadMore() {
    if (!live()) return
    for (const id of sourcesToLoad(sources)) {
      const next = sources[id]?.next
      if (next) fetchPage(id, next, generation)
    }
  }

  const marked = () => {
    markedUntil = time.now() + OWN_MARK_MS
  }
  const state: Live<InboxList> = {
    get: () => shown,
    subscribe: changed => {
      heard.add(changed)
      return () => {
        heard.delete(changed)
      }
    },
  }
  return {
    list: fromLive(
      time,
      state,
      (list, make) => {
        if (list.entries.length > 0) return make.ready(list)
        if (list.failure !== null) return make.failed(list.failure)
        return list.loadingMore || list.more ? make.loading() : make.empty()
      },
      reload
    ),
    anyUnread: { get: () => shown.entries.some(e => e.unread), subscribe: state.subscribe },
    adapterOf,
    start: () => {
      running = true
      markedUntil = 0
      reload()
      return () => {
        running = false
        generation += 1
      }
    },
    reload,
    loadMore,
    open: (entry, onClose) => {
      const adapter = adapterOf(entry.adapter)
      if (!adapter || !live()) return
      if (entry.unread && adapter.canPreview?.(entry) !== false) {
        marked()
        // The badge count follows the mark; a mark that fails leaves the entry unread.
        void adapter.markRead(entry).catch(reload)
      }
      onClose?.(true)
      void adapter.open(entry)
    },
    read: entry => {
      const adapter = adapterOf(entry.adapter)
      if (!adapter || !live()) return
      marked()
      put(markedRead(sources, entry.key, view.unread))
      void adapter.markRead(entry).then(
        () => {},
        () => reload()
      )
    },
    readAll: () => {
      if (!live()) return
      const entries = shown.entries
      marked()
      put(allRead(sources, view.unread))
      void Promise.allSettled(
        adapters.map(a =>
          a.markAll(
            view,
            entries.filter(e => e.adapter === a.id)
          )
        )
      ).then(reload)
    },
    markedUntil: () => markedUntil,
  }
}

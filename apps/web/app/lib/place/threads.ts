import type { AccountSession } from '../client/session'
import { chatKey } from '../p2p/app/store'
import { asMessage, looseNumber } from '../p2p/shown_message'
import { hostedThreadPage, pageThreads, pingedRows, type ThreadRow } from '../thread_list'
import { viewKey } from '../view'
import { defineFeature } from './feature'
import { built, type Live } from './live'
import type { P2pDm, P2pRoom } from './place'
import { shownOf } from './shown'

export interface ThreadPage {
  items: ThreadRow[]
  next: string | null
}

export interface ThreadsState {
  // The list of the conversation on screen, while it is open; a new key is a new list.
  open: string | null
  // A conversation with yourself.
  selfDm: boolean
  // The server whose member looks the roots' authors show; null without one.
  server: string | null
  // Whether the roots' authors are identity keys and not accounts.
  byKey: boolean
  // The rows as shown now (marked with the pings that are unread).
  shown: (rows: ThreadRow[]) => ThreadRow[]
}

export interface Threads {
  state: Live<ThreadsState>
  open: () => void
  close: () => void
  page: (query: string, cursor: string | null) => Promise<ThreadPage>
  // Closes the list and opens the thread beside the conversation.
  openThread: (row: ThreadRow) => void
  // Closes the list and shows the thread's root in the conversation.
  jump: (row: ThreadRow) => void
}

const hosted = (account: AccountSession): Threads => {
  const { store, api } = account
  const state = (initial: boolean) =>
    built(
      () => {
        const s = initial ? store.getInitialState() : store.getState()
        return [s.threads, s.view, s.dms, s.pings] as const
      },
      ([threads, view, dms, pings]): ThreadsState => ({
        open: view !== null && threads !== null && threads === viewKey(view) ? threads : null,
        selfDm: view?.kind === 'dm' && dms.some(d => d.id === view.dmId && d.is_self),
        server: view?.kind === 'channel' ? view.server : null,
        byKey: false,
        shown: rows => pingedRows(rows, pings),
      })
    )
  const listKey = () => {
    const { view } = store.getState()
    return view ? viewKey(view) : null
  }
  return {
    state: {
      get: state(false),
      initial: state(true),
      subscribe: changed => store.subscribe(changed),
    },
    open: () => store.getState().openThreads(),
    close: () => store.getState().closeThreads(),
    page: async (query, cursor) => {
      const key = store.getState().threads
      return key === null ? { items: [], next: null } : hostedThreadPage(api, key, query, cursor)
    },
    openThread: row => {
      store.getState().closeThreads()
      void store.getState().openThread(row.root)
    },
    jump: row => {
      const key = listKey()
      store.getState().closeThreads()
      if (key) void store.getState().jumpTo(key, row.root.id)
    },
  }
}

const unmarked = (rows: ThreadRow[]) => rows

const peer = (place: P2pRoom | P2pDm): Threads => {
  const { useP2p, p2pDm, p2pThread } = place.app
  const state = (initial: boolean) =>
    built(
      () => {
        const s = initial ? useP2p.getInitialState() : useP2p.getState()
        return [s.threads, s.chat] as const
      },
      ([threads, chat]): ThreadsState => ({
        open: threads !== null && chat !== null && threads === chatKey(chat) ? threads : null,
        selfDm: false,
        server: null,
        byKey: true,
        shown: unmarked,
      })
    )
  return {
    state: {
      get: state(false),
      initial: state(true),
      subscribe: changed => useP2p.subscribe(changed),
    },
    open: () => p2pDm.openThreads(),
    close: () => p2pDm.closeThreads(),
    page: async (query, cursor) => {
      const me = useP2p.getState().me ?? ''
      const { user, name } = shownOf(place).get()
      const all = (await p2pThread.list()).map(t => ({
        ...t,
        id: t.root.id,
        text: t.root.fwd ? t.root.fwd.body : t.root.body,
        names: [name(t.root.sender)],
      }))
      const page = pageThreads(all, query, cursor)
      return {
        items: page.items.map(t => ({
          key: t.id,
          root: asMessage(t.root, looseNumber(t.root), 0, user, me),
          files: (t.root.fwd?.att ?? t.root.att).length > 0,
          replies: t.root.replies ?? 0,
          lastAt: Math.floor((t.root.lastReply ?? t.root.ts) / 1000),
          pinged: t.pinged,
        })),
        next: page.next,
      }
    },
    openThread: row => {
      p2pDm.closeThreads()
      void p2pThread.open(row.key)
    },
    jump: row => {
      p2pDm.closeThreads()
      void p2pDm.jumpTo(row.key)
    },
  }
}

// The Threads list of the conversation a place has on screen.
export const threads = defineFeature<Threads>('threads', {
  hostedServer: place => hosted(place.account),
  p2pRoom: peer,
  hostedDm: place => hosted(place.account),
  p2pDm: peer,
})

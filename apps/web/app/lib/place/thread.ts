import type { AccountSession } from '../client/session'
import { identityScopeKey } from '../p2p/app/host'
import { threadScope } from '../p2p/app/store'
import { threadKey } from '../store'
import type { Message } from '../types'
import { findById } from '../window'
import { defineFeature } from './feature'
import { built, type Live } from './live'
import type { ListEnd } from './messages'
import type { P2pDm, P2pRoom } from './place'

export interface ThreadState {
  // The key the thread's scroll position and selection go by; null with no thread of the place
  // open.
  scope: string | null
  older: ListEnd
  newer: ListEnd
  // Whether a page loads as soon as its end of the list shows; where it does not, a control in
  // the list asks for it.
  pagesOnSight: boolean
  // The message the thread hangs from: on screen, on its way, or not stored here.
  root: 'shown' | 'loading' | 'missing'
  // How many replies the thread has.
  count: number
  // The replies are being fetched again.
  stale: boolean
  // Replies are on their way and none is placed yet.
  waiting: boolean
  // Something in the thread has not been seen.
  unseen: boolean
}

// The thread open beside the conversation of a place. Messages are named by `key` (an id as the
// place writes it).
export interface OpenThread {
  state: Live<ThreadState>
  loadOlder: () => void
  loadNewer: () => void
  toPresent: () => void
  // Shows the message in the thread.
  jump: (key: string) => void
  // Shows the message in the conversation the thread belongs to.
  jumpMain: (key: string) => void
  markRead: () => void
  close: () => void
}

const NONE: ListEnd = { more: false, loading: false }
const CLOSED: ThreadState = {
  scope: null,
  older: NONE,
  newer: NONE,
  pagesOnSight: false,
  root: 'missing',
  count: 0,
  stale: false,
  waiting: false,
  unseen: false,
}

const mainKey = (root: Message) =>
  root.channel_id !== null ? `c${root.channel_id}` : root.dm_id !== null ? `d${root.dm_id}` : null

const hosted = (account: AccountSession): OpenThread => {
  const { store } = account
  const rootOf = (initial: boolean) => {
    const s = initial ? store.getInitialState() : store.getState()
    return s.panel?.kind === 'thread' ? s.panel.root : null
  }
  const state = (initial: boolean) =>
    built(
      () => {
        const s = initial ? store.getInitialState() : store.getState()
        const root = rootOf(initial)
        if (!root) return [null, undefined, undefined, 0, false, false, false] as const
        const key = threadKey(root.id)
        const main = mainKey(root)
        const live = findById(main ? s.messages[main] : undefined, root.id) ?? root
        return [
          key,
          s.older[key],
          s.newer[key],
          live.reply_count,
          s.stale[key] === true,
          (s.messages[key]?.length ?? 0) === 0,
          s.pings[key] !== undefined,
        ] as const
      },
      ([scope, older, newer, count, stale, empty, unseen]): ThreadState =>
        scope === null
          ? CLOSED
          : {
              scope,
              older: { more: older?.more !== false, loading: older?.loading === true },
              newer: { more: newer?.more === true, loading: newer?.loading === true },
              pagesOnSight: true,
              root: 'shown',
              count,
              stale,
              waiting: stale && empty && count > 0,
              unseen,
            }
    )
  const at = (run: (root: Message, key: string) => void) => {
    const root = rootOf(false)
    if (root) run(root, threadKey(root.id))
  }
  return {
    state: {
      get: state(false),
      initial: state(true),
      subscribe: changed => store.subscribe(changed),
    },
    loadOlder: () => void store.getState().loadOlderThread(),
    loadNewer: () => void store.getState().loadNewerThread(),
    toPresent: () => at((_, key) => void store.getState().jumpToPresent(key)),
    jump: id => at((_, key) => void store.getState().jumpTo(key, Number(id))),
    jumpMain: id =>
      at(root => {
        const main = mainKey(root)
        if (main) void store.getState().jumpTo(main, Number(id))
      }),
    markRead: () =>
      at((root, key) => {
        if (store.getState().newer[key]?.more !== true) store.getState().seeThread(root.id)
      }),
    close: () => store.getState().closePanel(),
  }
}

const peer = (place: P2pRoom | P2pDm): OpenThread => {
  const { app, room } = place
  const { useP2p, p2pDm, p2pThread } = app
  const state = (initial: boolean) =>
    built(
      () => {
        const s = initial ? useP2p.getInitialState() : useP2p.getState()
        const t = s.thread !== null && s.thread.room === room ? s.thread : null
        const unseen =
          t === null
            ? 0
            : t.ch !== null
              ? s.servers[t.room]?.chans[t.ch]?.threads?.[t.root]
              : s.rooms[t.room]?.threads?.[t.root]
        return [t, (unseen ?? 0) > 0] as const
      },
      ([t, unseen]): ThreadState => {
        if (t === null) return CLOSED
        const none = t.messages.length === 0
        return {
          scope: identityScopeKey(app.localId, threadScope(t)),
          older: t.more ? { more: true, loading: false } : NONE,
          newer: NONE,
          pagesOnSight: false,
          root: t.head ? 'shown' : t.loading ? 'loading' : 'missing',
          count: t.head?.replies ?? t.messages.length,
          stale: t.loading && none,
          waiting: t.loading && none && (t.head?.replies ?? 1) > 0,
          unseen,
        }
      }
    )
  return {
    state: {
      get: state(false),
      initial: state(true),
      subscribe: changed => useP2p.subscribe(changed),
    },
    loadOlder: () => void p2pThread.loadOlder(),
    loadNewer: () => {},
    toPresent: () => {},
    jump: id => void p2pThread.jumpTo(id),
    jumpMain: id => void p2pDm.jumpTo(id),
    markRead: () => void p2pThread.markRead(),
    close: () => p2pThread.close(),
  }
}

// The thread open beside the conversation of a place.
export const thread = defineFeature<OpenThread>('thread', {
  hostedServer: place => hosted(place.account),
  p2pRoom: peer,
  hostedDm: place => hosted(place.account),
  p2pDm: peer,
})

const own = new WeakMap<AccountSession, OpenThread>()

// The account's own open thread, for a panel with no place around it.
export const accountThread = (account: AccountSession): OpenThread => {
  let known = own.get(account)
  if (!known) {
    known = hosted(account)
    own.set(account, known)
  }
  return known
}

import { ask, sendTo } from '../asks'
import type { AccountSession } from '../client/session'
import { identityScopeKey } from '../p2p/app/host'
import { chatKey, chatScope } from '../p2p/app/store'
import { lastOwn, unreadMark } from '../lists'
import type { Message } from '../types'
import { hostedUnread, p2pUnread, p2pUnreadStart, type UnreadSummary } from '../unread_banner'
import { viewKey } from '../view'
import { defineFeature } from './feature'
import { built, type Live } from './live'
import type { P2pDm, P2pRoom } from './place'
import { shownOf } from './shown'

// One end of a message list: whether more is stored past it, and whether a page is on its way.
export interface ListEnd {
  more: boolean
  loading: boolean
}

export interface MessagesState {
  // The key the list's scroll position and selection go by; null with no conversation of the
  // place on screen (or a voice channel).
  scope: string | null
  older: ListEnd
  newer: ListEnd
  // Whether a page loads as soon as its end of the list shows; where it does not, a control in
  // the list asks for it.
  pagesOnSight: boolean
}

// The message list of the conversation a place has on screen: where it is in its history, and
// how it moves. Messages are named by `key` (an id as the place writes it).
export interface Messages {
  state: Live<MessagesState>
  loadOlder: () => void
  loadNewer: () => void
  // Shows the message, loading the page around it when it is not in the list.
  jump: (key: string) => void
  toPresent: () => void
  toUnread: () => void
  // Everything up to `lastKey`, the newest message in the list, is read.
  markRead: (lastKey: string) => void
  // Drops the unread line without moving.
  dismissUnread: () => void
  unread: Live<UnreadState>
  // Looks up what the unread state needs from outside the list (the instance's count, the first
  // unread message in storage) for as long as the list is on screen. Returns its stop.
  watchUnread: () => () => void
}

// Where the unread part of the list starts, and what its banner says.
export interface UnreadState {
  // The row the "new" line sits above, as an index into the list's messages; -1 without one.
  divider: number
  // Null with nothing unread to announce.
  banner: UnreadSummary | null
}

// A value found outside the stores for `key`: asked for once per key while someone watches, and
// read back only under the key it was asked for.
const found = <T>(
  subscribe: (changed: () => void) => () => void,
  key: () => string | null,
  ask: () => Promise<T | null>
) => {
  let held: { key: string; value: T } | null = null
  let asked: string | null = null
  const heard = new Set<() => void>()
  const look = () => {
    const now = key()
    if (now === null) asked = null
    if (now === null || now === asked) return
    asked = now
    void ask().then(
      value => {
        if (value === null || asked !== now) return
        held = { key: now, value }
        for (const changed of heard) changed()
      },
      () => {}
    )
  }
  return {
    get: () => (held !== null && held.key === key() ? held.value : null),
    subscribe: (changed: () => void) => {
      const off = subscribe(changed)
      heard.add(changed)
      return () => {
        off()
        heard.delete(changed)
      }
    },
    watch: () => {
      look()
      const off = subscribe(look)
      return () => {
        off()
        asked = null
      }
    },
  }
}

const NO_UNREAD: UnreadState = { divider: -1, banner: null }

const NONE: ListEnd = { more: false, loading: false }
const NO_ROWS: Message[] = []

const hosted = (account: AccountSession): Messages => {
  const { store } = account
  const scopeOf = (initial: boolean) => {
    const s = initial ? store.getInitialState() : store.getState()
    const v = s.view
    if (!v) return null
    if (v.kind !== 'channel') return viewKey(v)
    const channel = s.servers[v.server]?.channels.find(c => c.id === v.channelId)
    return channel?.kind === 'voice' ? null : viewKey(v)
  }
  const state = (initial: boolean) =>
    built(
      () => {
        const s = initial ? store.getInitialState() : store.getState()
        const key = s.view ? viewKey(s.view) : null
        return [
          scopeOf(initial),
          key ? s.older[key] : undefined,
          key ? s.newer[key] : undefined,
        ] as const
      },
      ([scope, older, newer]): MessagesState => ({
        scope,
        older: { more: older?.more !== false, loading: older?.loading === true },
        newer: { more: newer?.more === true, loading: newer?.loading === true },
        pagesOnSight: true,
      })
    )
  const at = (run: (scope: string) => void) => {
    const scope = scopeOf(false)
    if (scope !== null) run(scope)
  }
  // The list as its unread part reads it: the rows, the read marker it opened with, and how
  // far it reaches.
  const marked = built(
    () => {
      const s = store.getState()
      const key = s.view ? viewKey(s.view) : null
      return [
        (key ? s.messages[key] : undefined) ?? NO_ROWS,
        key ? s.unreadAnchor[key] : undefined,
        s.me?.username,
        key === null || s.older[key]?.more !== false,
        key !== null && s.newer[key]?.more === true,
      ] as const
    },
    ([rows, anchor, me, olderMore, detached]) => {
      const ownLast = lastOwn(rows, me)
      const ids = rows.map(m => m.id)
      const mark = unreadMark(ids, anchor, olderMore, ownLast)
      // Opened in older history: every loaded message is at or before the read marker.
      const below =
        !!anchor && mark.divider < 0 && !mark.above && detached && (ids.at(-1) ?? 0) <= anchor
      return {
        rows: rows.map(m => ({ id: m.id, author: m.author.username, created_at: m.created_at })),
        me,
        mark,
        below,
        tail: !detached,
        after: Math.max(anchor ?? 0, ownLast),
      }
    }
  )
  const counted = found(
    changed => store.subscribe(changed),
    () => {
      const scope = scopeOf(false)
      if (scope === null) return null
      const { mark, below, tail, after } = marked()
      return mark.above || below || (mark.divider >= 0 && !tail) ? `${scope}:${after}` : null
    },
    () => {
      const scope = scopeOf(false)
      return scope === null
        ? Promise.resolve(null)
        : sendTo(account, ask.getUnreadCount(scope, marked().after))
    }
  )
  const unread = built(
    () => [marked(), counted.get(), scopeOf(false)] as const,
    ([{ rows, me, mark, below, tail, after }, count, scope]): UnreadState => {
      const summary = hostedUnread(rows, mark.divider, tail, me, after, count)
      const bannered =
        scope !== null && (mark.above || mark.divider >= 0 || (below && (summary.count ?? 0) > 0))
      return { divider: mark.divider, banner: bannered ? summary : null }
    }
  )
  return {
    unread: { get: unread, initial: () => NO_UNREAD, subscribe: counted.subscribe },
    watchUnread: counted.watch,
    state: {
      get: state(false),
      initial: state(true),
      subscribe: changed => store.subscribe(changed),
    },
    loadOlder: () => void store.getState().loadOlder(),
    loadNewer: () => void store.getState().loadNewer(),
    jump: key => at(scope => void store.getState().jumpTo(scope, Number(key))),
    toPresent: () => at(scope => void store.getState().jumpToPresent(scope)),
    toUnread: () => void store.getState().jumpToUnread(),
    markRead: lastKey => at(scope => store.getState().markRead(scope, Number(lastKey))),
    dismissUnread: () => at(scope => store.getState().dismissUnread(scope)),
  }
}

const peer = (place: P2pRoom | P2pDm): Messages => {
  const { app, room } = place
  const { useP2p, p2pDm } = app
  const shown = (initial: boolean) => {
    const { chat } = initial ? useP2p.getInitialState() : useP2p.getState()
    return chat !== null && chat.room === room ? chat : null
  }
  const state = (initial: boolean) =>
    built(
      () => {
        const chat = shown(initial)
        return [
          chat ? chatScope(chat.room, chat.ch) : null,
          chat?.more === true,
          !!chat?.newer,
          chat?.loading === true,
        ] as const
      },
      ([scope, more, newer, loading]): MessagesState => ({
        scope: scope === null ? null : identityScopeKey(app.localId, scope),
        older: more ? { more, loading: false } : NONE,
        newer: newer ? { more: newer, loading } : NONE,
        pagesOnSight: false,
      })
    )
  const at = (run: (key: string) => void) => {
    const chat = shown(false)
    if (chat) run(chatKey(chat))
  }
  const list = shownOf(place)
  // Where the unread part starts among the loaded rows, and whether it starts outside them.
  const marked = built(
    () => [shown(false), list.get()] as const,
    ([chat, { messages: rows, me }]) => {
      if (!chat) return null
      const start = p2pUnreadStart(rows, chat.readSeq, me, chat.more)
      // Unread messages that aren't loaded (or may be older than the first loaded row).
      const above =
        (start.first < 0 || start.ambiguous) &&
        !start.sent &&
        !!chat.readSeq &&
        (chat.unread ?? 0) > 0 &&
        !chat.loading
      return { chat, rows, me, start, above }
    }
  )
  // The first unread message when it isn't loaded, looked up in storage.
  const first = found(
    changed => useP2p.subscribe(changed),
    () => {
      const at = marked()
      return at?.above ? `${at.chat.room}:${at.chat.ch ?? ''}:${at.chat.readSeq}` : null
    },
    () => p2pDm.firstUnread()
  )
  const unread = built(
    () => [marked(), first.get()] as const,
    ([at, stored]): UnreadState => {
      if (!at) return NO_UNREAD
      const { chat, rows, me, start, above } = at
      const divider = start.ambiguous ? (stored && stored.id === rows[0]?.id ? 0 : -1) : start.first
      if (divider < 0 && !above) return NO_UNREAD
      const atOpen = { count: chat.unread ?? 0, seq: chat.unreadSeq ?? 0 }
      return { divider, banner: p2pUnread(rows, divider, !chat.newer, me, atOpen, stored) }
    }
  )
  return {
    unread: { get: unread, initial: () => NO_UNREAD, subscribe: first.subscribe },
    watchUnread: first.watch,
    state: {
      get: state(false),
      initial: state(true),
      subscribe: changed => useP2p.subscribe(changed),
    },
    loadOlder: () => void p2pDm.loadOlderPage(),
    loadNewer: () => void p2pDm.loadNewerPage(),
    jump: key => void p2pDm.jumpTo(key),
    toPresent: () => void p2pDm.toPresent(),
    toUnread: () => {
      const { divider } = unread()
      const loaded = divider >= 0 ? list.get().messages[divider] : undefined
      if (loaded) return void p2pDm.jumpTo(loaded.id)
      void p2pDm.firstUnread().then(stored => {
        if (stored) void p2pDm.jumpTo(stored.id)
      })
    },
    markRead: () =>
      at(key => {
        if (!shown(false)?.newer) p2pDm.markRead(key)
      }),
    dismissUnread: () => at(key => p2pDm.dismissUnread(key)),
  }
}

// The message list of the conversation a place has on screen.
export const messages = defineFeature<Messages>('messages', {
  hostedServer: place => hosted(place.account),
  p2pRoom: peer,
  hostedDm: place => hosted(place.account),
  p2pDm: peer,
})

const own = new WeakMap<AccountSession, Messages>()

// The account's own list, for a pane with no place open.
export const accountMessages = (account: AccountSession): Messages => {
  let known = own.get(account)
  if (!known) {
    known = hosted(account)
    own.set(account, known)
  }
  return known
}

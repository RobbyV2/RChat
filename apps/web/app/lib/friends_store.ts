import { client } from './client/client'
import type { AccountSession } from './client/session'
// The store's friends actions and events, kept apart from store.ts. `friendsSlice` gets the
// store's helpers and returns the actions plus the hooks the store calls on sign-in, resync,
// pings and WS events.

import { Ended } from './slices/ctx'
import { addPing, clearPings, pingUntil, setScopePings } from './pings'
import {
  FRIENDS_SCOPE,
  addRequest,
  matchesFriendQuery,
  parsePrivacy,
  placeFriend,
  sendLabel,
  setOnline,
  withoutUser,
  type FriendsTab,
  type SendResult,
} from './friends'
import type { Paged, RChatState } from './store_types'
import type { Friend, FriendRequest, Ping, UserRef, WsEvent } from './types'
import type { Page } from './lists'
import { mapWhere } from './window'
import { setDmFriend } from './dm_list'

type SetState = (partial: Partial<RChatState> | ((s: RChatState) => Partial<RChatState>)) => void

export interface FriendsDeps {
  acct: AccountSession
  set: SetState
  get: () => RChatState
  act: (fn: () => Promise<void>) => Promise<void>
  loadPage: <T>(
    id: string,
    read: () => Paged<T>,
    write: (page: Paged<T>) => void,
    fetchPage: (cursor: string | null) => Promise<Page<T>>,
    keyOf: (item: T) => string,
    q: string,
    reset: boolean
  ) => Promise<void>
  toast: (text: string, name?: string) => void
  fail: (e: unknown) => void
  errorText: (e: unknown) => string
}

const empty = <T>(): Paged<T> => ({ list: [], hasMore: true, loading: false, q: '' })

export const friendsInitial = () => ({
  friends: empty<Friend>(),
  onlineFriends: empty<Friend>(),
  incomingRequests: empty<FriendRequest>(),
  outgoingRequests: empty<FriendRequest>(),
  friendCounts: { incoming: 0, outgoing: 0 },
  privacy: null,
})

const byName = (r: FriendRequest | Friend) => r.user.username

export const friendsSlice = (d: FriendsDeps) => {
  const { acct } = d
  const api = acct.api
  const { live, sessionMark } = acct.lifetime
  const { set, get, act } = d
  const signedIn = () => !!get().me && !get().guest
  const mine = (username: string) => get().me?.username === username

  type Field = 'friend' | 'incoming' | 'outgoing' | 'block'
  let dialogSeq = 0
  let nextWrite = 0
  type Updates = { user?: UserRef; online?: boolean }
  const pending = new Set<{
    name: string
    order: number
    superseded: Set<Field>
    latest: Updates
  }>()
  // A parked account may receive profile or presence before it has a friend row to update.
  // Retain these fields only for replies already in flight for this account and username.
  const observe = (name: string, fields: Updates) => {
    for (const write of pending) if (write.name === name) Object.assign(write.latest, fields)
  }
  const changed = (name: string, field: Field, order = Infinity) => {
    for (const write of pending)
      if (write.name === name && write.order < order) write.superseded.add(field)
  }

  // Only successful writes supersede older replies. Track each part separately because,
  // for example, removing an accepted friend does not reconcile the incoming request.
  const mutate = async <T, R>(
    username: string,
    request: () => Promise<T>,
    apply: (result: T, claim: (field: Field) => boolean, latest: Updates) => R
  ) => {
    const name = username.trim().toLowerCase()
    const write = { name, order: ++nextWrite, superseded: new Set<Field>(), latest: {} }
    const at = sessionMark()
    pending.add(write)
    try {
      const result = await request()
      if (at !== sessionMark()) throw new Ended('The session ended')
      return apply(
        result,
        field => {
          if (write.superseded.has(field)) return false
          changed(name, field, write.order)
          return true
        },
        write.latest
      )
    } finally {
      pending.delete(write)
    }
  }

  let summaryAsked = 0
  const loadSummary = async () => {
    if (!get().me || get().guest) return
    const asked = ++summaryAsked
    const at = sessionMark()
    let sum: Awaited<ReturnType<typeof api.friendSummary>>
    try {
      sum = await api.friendSummary()
    } catch {
      return
    }
    if (asked !== summaryAsked || at !== sessionMark() || typeof sum !== 'object' || !sum) return
    const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0)
    set(s => ({
      friendCounts: { incoming: n(sum.incoming), outgoing: n(sum.outgoing) },
      pings: setScopePings(s.pings, FRIENDS_SCOPE, null, {
        pings: n(sum.pings),
        pings_until: n(sum.pings_until),
      }),
    }))
  }

  let observed = 0
  const visiblePanel = () =>
    observed > 0 ||
    (get().panel?.kind === 'friends' &&
      client.shown() === acct &&
      client.live().filter(a => a.store.getState().me).length < 2)
  const reloadOpenLists = () => {
    const s = get()
    if (!visiblePanel()) {
      set({
        friends: empty<Friend>(),
        onlineFriends: empty<Friend>(),
        incomingRequests: empty<FriendRequest>(),
        outgoingRequests: empty<FriendRequest>(),
      })
      return
    }
    void actions.loadFriends(s.friends.q, true)
    void actions.loadOnlineFriends(s.onlineFriends.q, true)
    void actions.loadFriendRequests(true, true)
    void actions.loadFriendRequests(false, true)
  }

  const panelOpen = () => visiblePanel() && pageVisible()

  const pageVisible = () => typeof document === 'undefined' || document.visibilityState !== 'hidden'

  const markSeen = () => {
    const until = pingUntil(get().pings[FRIENDS_SCOPE])
    if (!until) return
    set(s => ({ pings: clearPings(s.pings, FRIENDS_SCOPE, until) }))
    if (get().token) void api.friendsSeen(until).catch(() => {})
  }

  const putFriend = (f: Friend) =>
    set(s => {
      const fits = (p: Paged<Friend>) => matchesFriendQuery(f.user, p.q)
      const all = fits(s.friends)
        ? { ...s.friends, list: placeFriend(s.friends.list, f, s.friends.hasMore) }
        : s.friends
      const online =
        f.online && fits(s.onlineFriends)
          ? {
              ...s.onlineFriends,
              list: placeFriend(s.onlineFriends.list, f, s.onlineFriends.hasMore),
            }
          : { ...s.onlineFriends, list: withoutUser(s.onlineFriends.list, f.user.username) }
      return { friends: all, onlineFriends: online }
    })

  const dropFriend = (name: string) =>
    set(s => ({
      friends: { ...s.friends, list: withoutUser(s.friends.list, name) },
      onlineFriends: { ...s.onlineFriends, list: withoutUser(s.onlineFriends.list, name) },
    }))

  const noteFriend = (name: string, friend: Friend | null) => {
    if (friend) putFriend(friend)
    else dropFriend(name)
    set(s => ({ dms: setDmFriend(s.dms, name, !!friend) }))
    // A page already in flight may have been read before this change.
    if (get().friends.loading) void actions.loadFriends(get().friends.q, true)
    if (get().onlineFriends.loading) void actions.loadOnlineFriends(get().onlineFriends.q, true)
  }

  const dropRequest = (name: string, incoming: boolean) => {
    const field = incoming ? 'incomingRequests' : 'outgoingRequests'
    set(s => {
      const page = s[field]
      const list = withoutUser(page.list, name)
      if (list === page.list) return {}
      const direction = incoming ? 'incoming' : 'outgoing'
      // Complete pages already contain the exact remaining count. Partial pages use the summary.
      return {
        [field]: { ...page, list },
        friendCounts:
          page.hasMore || page.loading
            ? s.friendCounts
            : { ...s.friendCounts, [direction]: list.length },
      }
    })
    if (get()[field].loading) void actions.loadFriendRequests(incoming, true)
  }

  const reconcileBlock = (name: string, claim: (field: Field) => boolean) => {
    if (claim('friend')) noteFriend(name, null)
    if (claim('incoming')) dropRequest(name, true)
    if (claim('outgoing')) dropRequest(name, false)
    void loadSummary()
  }

  const actions = {
    openFriends: (tab: FriendsTab = 'online') => {
      if (!signedIn()) return
      set({ panel: { kind: 'friends', tab } })
      if (panelOpen()) markSeen()
    },

    setFriendsTab: (tab: FriendsTab) => {
      if (get().panel?.kind === 'friends') set({ panel: { kind: 'friends', tab } })
    },

    loadFriends: (q: string, reset = false) =>
      act(() =>
        d.loadPage(
          'friends',
          () => get().friends,
          friends => set({ friends }),
          cursor => api.friends(cursor, q),
          byName,
          q,
          reset
        )
      ),

    loadOnlineFriends: (q: string, reset = false) =>
      act(() =>
        d.loadPage(
          'friends_online',
          () => get().onlineFriends,
          onlineFriends => set({ onlineFriends }),
          cursor => api.friends(cursor, q, true),
          byName,
          q,
          reset
        )
      ),

    loadFriendRequests: (incoming: boolean, reset = false) =>
      act(() =>
        d.loadPage(
          incoming ? 'friend_requests_in' : 'friend_requests_out',
          () => (incoming ? get().incomingRequests : get().outgoingRequests),
          page => set(incoming ? { incomingRequests: page } : { outgoingRequests: page }),
          cursor => api.friendRequests(incoming, cursor),
          byName,
          '',
          reset
        )
      ),

    sendFriendRequest: async (username: string): Promise<SendResult> => {
      if (!signedIn()) return { ok: false, error: 'Sign in to add friends' }
      try {
        const res = await mutate(
          username,
          () => api.sendFriendRequest(username.trim()),
          (r, claim, latest) => {
            // Send returns a status and profile, without the canonical timestamp or presence.
            if (r.status === 'sent') {
              if (claim('outgoing')) void actions.loadFriendRequests(false, true)
            } else {
              if (claim('friend')) {
                set(s => ({ dms: setDmFriend(s.dms, r.user.username, true) }))
                void actions.loadFriends(get().friends.q, true)
                void actions.loadOnlineFriends(get().onlineFriends.q, true)
              }
              if (claim('incoming')) dropRequest(r.user.username, true)
              if (claim('outgoing')) dropRequest(r.user.username, false)
            }
            void loadSummary()
            return { status: r.status, user: latest.user ?? r.user }
          }
        )
        return { ok: true, ...res }
      } catch (e) {
        return { ok: false, error: d.errorText(e) }
      }
    },

    // One request per name, in order; resolves to each result.
    sendFriendRequests: async (names: string[]) => {
      const out: Record<string, SendResult> = {}
      const at = sessionMark()
      for (const name of names) {
        out[name] = await actions.sendFriendRequest(name)
        if (at !== sessionMark()) return out
      }
      const done = Object.values(out).filter(r => r.ok)
      const only = done.length === 1 && names.length === 1 ? done[0] : null
      if (only?.ok) d.toast(sendLabel(only.status), only.user.display_name)
      else if (done.length) d.toast(`Sent ${done.length} of ${names.length} friend requests`)
      return out
    },

    // The confirm with mini profile previews; the names come from the add box, a profile or the
    // palette.
    askAddFriends: (names: string[]) => {
      if (!signedIn() || !names.length) return
      set({ activeDialog: { kind: 'add_friends', names, id: ++dialogSeq } })
    },

    acceptFriend: (user: UserRef) =>
      act(async () => {
        await mutate(
          user.username,
          () => api.acceptFriend(user.username),
          (reply, claim, latest) => {
            const friend = { ...reply, ...latest }
            if (claim('incoming')) dropRequest(friend.user.username, true)
            if (claim('friend')) noteFriend(friend.user.username, friend)
            void loadSummary()
            d.toast('Now friends with', friend.user.display_name)
          }
        )
      }),

    denyFriend: (username: string) =>
      act(async () => {
        await mutate(
          username,
          () => api.denyFriend(username),
          (_, claim) => {
            if (claim('incoming')) dropRequest(username.trim().toLowerCase(), true)
            void loadSummary()
          }
        )
      }),

    cancelFriendRequest: (username: string) =>
      act(async () => {
        await mutate(
          username,
          () => api.cancelFriendRequest(username),
          (_, claim) => {
            if (claim('outgoing')) dropRequest(username.trim().toLowerCase(), false)
            void loadSummary()
          }
        )
      }),

    removeFriend: (user: UserRef) =>
      act(async () => {
        await mutate(
          user.username,
          () => api.removeFriend(user.username),
          (_, claim) => {
            if (claim('friend')) noteFriend(user.username, null)
            void loadSummary()
            d.toast('Removed friend', user.display_name)
          }
        )
      }),

    askRemoveFriend: (user: UserRef) => {
      if (!signedIn()) return
      get().askConfirm({
        title: 'Remove friend',
        body: `Remove ${user.display_name} from your friends?`,
        confirm: 'Remove',
        action: acct.lifetime.inSession(() => void actions.removeFriend(user)),
      })
    },

    loadPrivacy: async () => {
      if (!get().me || get().guest) return
      const at = sessionMark()
      try {
        const raw = await api.privacy()
        if (at === sessionMark()) set({ privacy: parsePrivacy(raw) })
      } catch (e) {
        if (at === sessionMark()) d.fail(e)
      }
    },

    setPrivacy: (patch: Partial<NonNullable<RChatState['privacy']>>) =>
      act(async () => {
        if (!get().me || get().guest) return
        const prev = get().privacy
        if (prev) set({ privacy: { ...prev, ...patch } })
        try {
          const raw = await live(api.setPrivacy(patch))
          set({ privacy: parsePrivacy(raw) })
        } catch (e) {
          if (!(e instanceof Ended)) set({ privacy: prev })
          throw e
        }
      }),

    observeFriendsPanel: () => {
      observed++
      const reveal = () => {
        if (pageVisible()) markSeen()
      }
      reveal()
      if (typeof document !== 'undefined') document.addEventListener('visibilitychange', reveal)
      return () => {
        observed--
        if (typeof document !== 'undefined')
          document.removeEventListener('visibilitychange', reveal)
      }
    },
    markFriendsSeen: markSeen,
  }

  // A `ping` in the friends scope: counted unless the friends panel is open, then a toast.
  const onPing = (ping: Ping, alert: (go: () => void, action: string, actor: UserRef) => void) => {
    const request = ping.kind === 'friend_request'
    if (panelOpen()) {
      set(s => ({ pings: addPing(s.pings, ping) }))
      markSeen()
      return
    }
    set(s => ({ pings: addPing(s.pings, ping) }))
    alert(
      () => actions.openFriends(request ? 'pending' : 'all'),
      request ? 'sent you a friend request' : 'accepted your friend request',
      ping.actor
    )
  }

  // Returns true when the event was a friends event and nothing else handles it.
  const onEvent = (ev: WsEvent): boolean => {
    switch (ev.type) {
      case 'user_blocked':
        if (mine(ev.username)) changed(ev.blocked.user.username, 'block')
        return false
      case 'user_unblocked':
        if (mine(ev.username)) changed(ev.blocked, 'block')
        return false
      case 'friend_request_added': {
        if (!mine(ev.username)) return true
        const r = ev.request
        changed(r.user.username, r.incoming ? 'incoming' : 'outgoing')
        set(s =>
          r.incoming
            ? {
                incomingRequests: {
                  ...s.incomingRequests,
                  list: addRequest(s.incomingRequests.list, r),
                },
              }
            : {
                outgoingRequests: {
                  ...s.outgoingRequests,
                  list: addRequest(s.outgoingRequests.list, r),
                },
              }
        )
        if ((r.incoming ? get().incomingRequests : get().outgoingRequests).loading)
          void actions.loadFriendRequests(r.incoming, true)
        void loadSummary()
        return true
      }
      case 'friend_request_removed': {
        if (!mine(ev.username)) return true
        changed(ev.other, 'incoming')
        changed(ev.other, 'outgoing')
        dropRequest(ev.other, true)
        dropRequest(ev.other, false)
        void loadSummary()
        return true
      }
      case 'friend_added': {
        if (!mine(ev.username)) return true
        changed(ev.friend.user.username, 'friend')
        noteFriend(ev.friend.user.username, ev.friend)
        return true
      }
      case 'friend_removed': {
        if (!mine(ev.username)) return true
        changed(ev.friend, 'friend')
        noteFriend(ev.friend, null)
        return true
      }
      case 'friend_presence': {
        if (!mine(ev.username)) return true
        observe(ev.friend, { online: ev.online })
        const known = get().friends.list.find(f => f.user.username === ev.friend)
        set(s => ({
          friends: { ...s.friends, list: setOnline(s.friends.list, ev.friend, ev.online) },
        }))
        if (known) putFriend({ ...known, online: ev.online })
        else if (!ev.online)
          set(s => ({
            onlineFriends: {
              ...s.onlineFriends,
              list: withoutUser(s.onlineFriends.list, ev.friend),
            },
          }))
        else if (visiblePanel()) void actions.loadOnlineFriends(get().onlineFriends.q, true)
        return true
      }
      case 'privacy_changed': {
        if (mine(ev.username)) set({ privacy: parsePrivacy(ev.privacy) })
        return true
      }
      case 'user_updated': {
        const u = ev.user
        observe(u.username, { user: u })
        const same = (x: { user: UserRef }) => x.user.username === u.username
        const fresh = <T extends { user: UserRef }, P extends { list: T[] }>(page: P): P => {
          const list = mapWhere(page.list, same, x => ({ ...x, user: u }))
          return list === page.list ? page : { ...page, list }
        }
        set(s => ({
          friends: fresh(s.friends),
          onlineFriends: fresh(s.onlineFriends),
          incomingRequests: fresh(s.incomingRequests),
          outgoingRequests: fresh(s.outgoingRequests),
        }))
        return false
      }
      default:
        return false
    }
  }

  return {
    actions,
    mutate,
    reconcileBlock,
    loadSummary,
    reloadOpenLists,
    onPing,
    onEvent,
  }
}

import { createApi } from '../api'
import { mergeGroupPings } from '../group_pings'
import { readLocal, writeLocal } from '../instances'
import { notifyKey, parseNotify, unreadShown } from '../notify'
import { ownWork } from '../own_loads'
import { FRIENDS_SCOPE } from '../friends'
import { mergePings, setScopePings } from '../pings'
import { mergeReads } from '../reads'
import { allPings } from '../selectors'
import type { RChatState } from '../store_types'
import { client } from './client'
import { accountStorage } from './keys'
import type { AccountSession } from './session'
import { readToken } from './credentials'
import { time } from '../platform/time'
import { anything, int, jsonOr, obj, opt, record, union, type Schema } from '../schema'

interface Counts {
  incoming: number
  instance: number
  peers: Readonly<Record<string, number>>
  unread: number
}

const emptyCounts: Counts = { incoming: 0, instance: 0, unread: 0, peers: {} }
const count = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
const total = (counts: Counts) =>
  counts.instance + Object.values(counts.peers).reduce((sum, n) => sum + n, 0)
const equal = (a: Counts | null, b: Counts) =>
  a?.instance === b.instance &&
  a.incoming === b.incoming &&
  a.unread === b.unread &&
  Object.keys(a.peers).length === Object.keys(b.peers).length &&
  Object.entries(a.peers).every(([id, n]) => b.peers[id] === n)

function username(account: AccountSession) {
  const state = account.store.getState()
  return state.me?.username ?? (state.guest ? null : account.credentialTarget)
}

function countsKey(account: AccountSession, owner: string) {
  return 'rchat_counts:' + JSON.stringify([account.conn.origin, owner])
}

const COUNT = int().refine(n => n >= 0, 'a count')
// A stored record; an older one has `badge` in place of `instance`, and no peers.
const STORED_COUNTS: Schema<Counts> = union(
  obj({ unread: COUNT, instance: COUNT, peers: record(COUNT), incoming: opt(anything) }).map(c => ({
    incoming: count(c.incoming) ? c.incoming : 0,
    instance: c.instance,
    unread: c.unread,
    peers: c.peers,
  })),
  obj({ unread: COUNT, badge: COUNT }).map(c => ({
    incoming: 0,
    instance: c.badge,
    unread: c.unread,
    peers: {},
  }))
)

function readCounts(key: string): Counts | null {
  try {
    return jsonOr(readLocal(key), STORED_COUNTS, null)
  } catch {
    return null
  }
}

function unreadCount(state: RChatState) {
  const now = time().now()
  return Object.entries(state.reads).filter(
    ([scope, mark]) =>
      mark.latest > mark.lastRead && unreadShown(state.notifyPrefs, scope, mark.server ?? null, now)
  ).length
}

export function createAccountCounts(account: AccountSession) {
  let key: string | null = null
  let saved: Counts | null = null
  let displayed = emptyCounts
  let previousPeers: Counts['peers'] = {}
  let polling: object | null = null
  const listeners = new Set<() => void>()
  const track = (owner: string | null | undefined) => {
    const next = owner ? countsKey(account, owner) : null
    if (key !== next) {
      key = next
      saved = key ? readCounts(key) : null
      previousPeers = saved?.peers ?? {}
    }
  }
  const persist = (counts: Counts) => {
    if (!key) return
    saved = counts
    if (equal(readCounts(key), counts)) return
    // A parked request compares the raw record, even before storage events arrive.
    const generation = Array.from(crypto.getRandomValues(new Uint32Array(4))).join('-')
    writeLocal(key, JSON.stringify({ ...counts, generation }))
  }
  const refresh = () => {
    const owner = username(account)
    track(owner)
    const state = account.store.getState()
    const leader = !!owner && account.deliveryLock.holds(account.conn.origin, owner)
    let instance = allPings(state)
    const peers: Record<string, number> = Object.create(null)
    for (const adapter of account.inbox.inboxAdapters()) {
      if (!adapter.count || adapter.countReady?.() === false) continue
      if (adapter.id.startsWith('p2p:'))
        peers[decodeURIComponent(adapter.id.slice(4))] = adapter.count()
      else instance += adapter.count()
    }
    if (owner && Object.keys(previousPeers).some(id => !(id in peers)))
      for (const id of account.identities.enabledIds(owner))
        if (!(id in peers) && Object.hasOwn(previousPeers, id)) peers[id] = previousPeers[id]!
    previousPeers = peers
    const local = {
      incoming: state.friendCounts.incoming,
      instance,
      peers,
      unread: unreadCount(state),
    }
    const follows = account.mode === 'parked' || (account.mode === 'lite' && !leader)
    if (!follows && leader && state.me && state.readsReady) {
      persist(local)
    }
    const next = follows ? (saved ?? local) : local
    if (!equal(displayed, next)) {
      displayed = next
      for (const fn of listeners) fn()
    }
  }
  const start = () => {
    const page = window
    const onStorage = (event: StorageEvent) => {
      track(username(account))
      if (key && (event.key === key || event.key === null)) {
        polling = null
        saved = readCounts(key)
        previousPeers = saved?.peers ?? {}
        refresh()
      }
    }
    const offStore = account.store.subscribe((s, prev) => {
      if (
        s.reads !== prev.reads ||
        s.readsReady !== prev.readsReady ||
        s.friendCounts !== prev.friendCounts ||
        s.me !== prev.me ||
        s.guest !== prev.guest ||
        s.pings !== prev.pings ||
        s.groupPings !== prev.groupPings ||
        s.notifyPrefs !== prev.notifyPrefs
      )
        refresh()
    })
    const offInbox = account.inbox.subscribeCounts(refresh)
    const offLock = account.deliveryLock.subscribe(refresh)
    const offClient = client.subscribe(refresh)
    page.addEventListener('storage', onStorage)
    refresh()
    return () => {
      page.removeEventListener('storage', onStorage)
      offStore()
      offInbox()
      offLock()
      offClient()
    }
  }
  const poll = async () => {
    const owner = username(account)
    const origin = account.conn.origin
    if (polling || !owner || account.mode !== 'parked' || !account.tabLock.holds(origin, owner))
      return
    const keyset = accountStorage(account.conn)
    const tokenKey = keyset.token(owner)
    const token = readToken(tokenKey)
    if (!token) return
    const mark = account.lifetime.sessionMark()
    const api = createApi(account.conn.apiBase, 'omit')
    api.prefix = account.api.prefix
    api.setToken(token)
    const valid = () =>
      account.lifetime.sessionMark() === mark &&
      username(account) === owner &&
      account.conn.origin === origin &&
      client.live().includes(account) &&
      token.same(readToken(tokenKey))
    const snapshotKey = countsKey(account, owner)
    const atStart = readLocal(snapshotKey)
    const initial = account.store.getState()
    const request = {}
    polling = request
    // A parked account's failed check is kept on the account, for the row that shows its counts.
    const record = (what: 'unread_counts' | 'friend_summary') => {
      const kept = ownWork(account.store.setState, what)
      return {
        came: () => {
          if (valid()) kept.came()
        },
        refused: (error: unknown) => {
          if (valid()) kept.refused(error)
        },
      }
    }
    const unreads = record('unread_counts')
    const summary = record('friend_summary')
    try {
      const [{ items, more }, friends] = await Promise.all([
        api.getUnreads(),
        api.friendSummary().then(
          found => {
            summary.came()
            return found
          },
          (error: unknown) => {
            summary.refused(error)
            return null
          }
        ),
      ])
      unreads.came()
      await account.deliveryLock.ifIdle(origin, owner, () => {
        if (
          readLocal(snapshotKey) !== atStart ||
          polling !== request ||
          !valid() ||
          account.mode !== 'parked' ||
          !account.tabLock.holds(origin, owner)
        )
          return
        track(owner)
        const before = readCounts(snapshotKey)
        saved = before
        const state = account.store.getState()
        const notifyPrefs = state.me
          ? state.notifyPrefs
          : parseNotify(readLocal(account.conn.scoped(notifyKey(owner))))
        const pings = mergePings(initial.pings, state.pings, items)
        const friendCounts =
          friends &&
          initial.friendCounts === state.friendCounts &&
          count(friends.incoming) &&
          count(friends.outgoing)
            ? { incoming: friends.incoming, outgoing: friends.outgoing }
            : state.friendCounts
        account.store.setState({
          friendCounts,
          reads: mergeReads(initial.reads, state.reads, items, () => 0),
          pings:
            friends && initial.pings[FRIENDS_SCOPE] === state.pings[FRIENDS_SCOPE]
              ? setScopePings(pings, FRIENDS_SCOPE, null, friends)
              : pings,
          groupPings: mergeGroupPings(initial.groupPings, state.groupPings, items),
          readsReady: true,
          unreadsCut: more,
          notifyPrefs,
        })
        const latest = account.store.getState()
        const counts = {
          incoming:
            latest.friendCounts !== initial.friendCounts
              ? latest.friendCounts.incoming
              : (before?.incoming ?? latest.friendCounts.incoming),
          instance: allPings(latest),
          peers: saved?.peers ?? {},
          unread: unreadCount(latest),
        }
        if (polling !== request || !valid() || readLocal(snapshotKey) !== atStart) return
        persist(counts)
        refresh()
        if (
          polling === request &&
          valid() &&
          before &&
          equal(readCounts(snapshotKey), counts) &&
          (counts.unread > before.unread || counts.instance > before.instance)
        ) {
          latest.alertFrom({
            key: 'parked-inbox',
            actor: null,
            action: '',
            body: '',
            server: null,
            channel: null,
            dm: false,
            message: false,
            name: 'New activity',
            generic: 'New activity',
            go: () => {
              if (!valid()) return false
              account.store.getState().setInboxOpen(true)
            },
          })
        }
      })
    } catch (error) {
      // The last known count stays until the next poll.
      unreads.refused(error)
    } finally {
      if (polling === request) polling = null
    }
  }
  return {
    start,
    poll,
    value: () => total(displayed),
    breakdown: () => displayed,
    peerRemoved(owner: string, id: string) {
      if (username(account) !== owner) return
      track(owner)
      const current = key && readCounts(key)
      if (current && Object.hasOwn(current.peers, id)) {
        const peers = { ...current.peers }
        delete peers[id]
        persist({ ...current, peers })
      }
      refresh()
    },
    modeChanged() {
      polling = null
      const owner = username(account)
      track(owner)
      if (owner && account.mode === 'parked' && account.tabLock.holds(account.conn.origin, owner)) {
        saved = key ? readCounts(key) : null
        const peers: Record<string, number> = Object.assign(Object.create(null), saved?.peers)
        for (const adapter of account.inbox.inboxAdapters())
          if (adapter.count && adapter.countReady?.() !== false && adapter.id.startsWith('p2p:'))
            peers[decodeURIComponent(adapter.id.slice(4))] = adapter.count()
        if (saved || account.store.getState().readsReady || Object.keys(peers).length)
          persist({
            incoming: saved?.incoming ?? account.store.getState().friendCounts.incoming,
            instance: saved?.instance ?? allPings(account.store.getState()),
            unread: saved?.unread ?? unreadCount(account.store.getState()),
            peers,
          })
      }
      refresh()
    },
    subscribe: (fn: () => void) => {
      listeners.add(fn)
      return () => {
        listeners.delete(fn)
      }
    },
  }
}

export const startAccountCounts = (account: AccountSession) => account.counts.start()
export const pollAccountCounts = (account: AccountSession) => account.counts.poll()

export function totalInboxCount(sessions: readonly AccountSession[]) {
  const seen = new Set<string>()
  let sum = 0
  for (const account of sessions) {
    const owner = username(account)
    if (!owner) continue
    const key = countsKey(account, owner)
    if (seen.has(key)) continue
    seen.add(key)
    sum += account.counts.value()
  }
  return sum
}

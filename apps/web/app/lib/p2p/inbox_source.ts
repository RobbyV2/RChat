import { create } from 'zustand'
import type { InboxAdapter, InboxEntry, InboxView } from '../inbox'
import { levelOf, type NotifyPrefs } from '../notify'
import type { AccountSession } from '../client/session'
import type { P2pState } from './app'
import { type P2pApp } from './app/runtime'
import { displayName } from './contacts'
import {
  byCounter,
  counterKey,
  markAllTargets,
  newerFirst,
  P2P_INBOX,
  pagePings,
  pingEntry,
  pingInView,
  pingUnread,
  pingVisible,
  type PingRec,
  type PingWorld,
} from './inbox'

export const worldOf = (st: P2pState, readSeq: ReadonlyMap<string, number>): PingWorld => ({
  readSeq,
  dms: new Map(Object.values(st.rooms).map(r => [r.id, r.peer])),
  contacts: new Set(st.contacts.map(c => c.ik)),
  blocked: new Set(st.contacts.filter(c => c.state === 'blocked').map(c => c.ik)),
  servers: st.servers,
})

// Whether a ping badges: its conversation or channel isn't set to "Nothing".
export const pingNotifies = (prefs: NotifyPrefs, p: Pick<PingRec, 'room' | 'ch'>) =>
  levelOf(
    prefs,
    p.ch === null ? { kind: 'p2p', room: p.room } : { kind: 'p2pc', room: p.room, ch: p.ch }
  ) !== 'nothing'

// The pings a view lists (before those whose message is gone drop out).
export const listedIn =
  (view: InboxView, w: PingWorld, prefs: NotifyPrefs) =>
  (p: PingRec): boolean =>
    pingVisible(p, w) &&
    pingInView(p, view) &&
    (!view.unread || (pingUnread(p, w.readSeq) && pingNotifies(prefs, p)))

// Whether each ping's message was still there, by the room's stored content then.
type Checked = Map<string, { seq: number; ok: boolean }>

// Unread pings the list can show, by counter (`{room}` or `{room}/{channel}`).
export const listedPings = async (
  checked: Checked = new Map(),
  app: P2pApp
): Promise<Map<string, number> | null> => {
  const { p2pPings, useP2p } = app
  const snap = await p2pPings.read()
  const st = useP2p.getState()
  if (!snap || !st.enabled) return null
  const w = worldOf(st, snap.readSeq)
  if (
    snap.list.some(
      p => p.ch !== null && st.servers[p.room]?.awaitingAcl && pingUnread(p, w.readSeq)
    )
  )
    return null
  const rows = snap.list.filter(p => pingUnread(p, w.readSeq) && pingVisible(p, w))
  const seqOf = (room: string) => st.rooms[room]?.seq ?? st.servers[room]?.seq ?? -1
  const next = new Map<string, { seq: number; ok: boolean }>()
  const ok = await Promise.all(
    rows.map(async p => {
      const seq = seqOf(p.room)
      const was = checked.get(p.id)
      const now = was && was.seq === seq ? was.ok : await p2pPings.alive(p)
      next.set(p.id, { seq, ok: now })
      return now
    })
  )
  checked.clear()
  for (const [id, value] of next) checked.set(id, value)
  return byCounter(rows.filter((_, i) => ok[i]))
}

const createListedPings = () =>
  create<{ by: ReadonlyMap<string, number>; loaded: object | null }>(() => ({
    loaded: null,
    by: new Map(),
  }))

const listedByApp = new WeakMap<P2pApp, ReturnType<typeof createListedPings>>()

export const listedStore = (app: P2pApp) => {
  const existing = listedByApp.get(app)
  if (existing) return existing
  const store = createListedPings()
  listedByApp.set(app, store)
  return store
}

// What the bell and the tab title count of P2P: each counter that badges, but no more than the
// unread pings the list can show there (pings by blocked people, on deleted messages, in servers
// left, or noted before the log, can't be shown or cleared there).
export const p2pPingCount = (
  st: Pick<P2pState, 'rooms' | 'servers'>,
  prefs: NotifyPrefs,
  listed: ReadonlyMap<string, number>
) => {
  const counted = (room: string, ch: string | null, pings: number) =>
    pingNotifies(prefs, { room, ch })
      ? Math.min(pings, listed.get(counterKey({ room, ch })) ?? 0)
      : 0
  let n = 0
  for (const r of Object.values(st.rooms)) n += counted(r.id, null, r.pings)
  for (const v of Object.values(st.servers))
    for (const [ch, c] of Object.entries(v.chans)) n += counted(v.id, ch, c.pings)
  return n
}

const inputsOf = {
  rooms: (st: P2pState) =>
    Object.values(st.rooms)
      .map(r => `${r.id}:${r.peer}:${r.seq}:${r.pings}:${r.unread}`)
      .join(),
  servers: (st: P2pState) =>
    Object.values(st.servers)
      .map(
        v =>
          `${v.id}:${v.me}:${v.awaitingAcl}:${v.seq}:${v.channels.map(c => c.id).join('/')}:${Object.entries(
            v.chans
          )
            .map(([ch, c]) => `${ch}=${c.pings}/${c.readSeq}`)
            .join('/')}`
      )
      .join(),
  contacts: (st: P2pState) => st.contacts.map(c => `${c.ik}:${c.state}`).join(),
}

// What the listed pings depend on changed: the log, read positions, counters, stored content,
// places or contacts (not typing or presence).
export const pingInputsChanged = (st: P2pState, prev: P2pState) =>
  st.countsLoaded !== prev.countsLoaded ||
  st.enabled !== prev.enabled ||
  st.me !== prev.me ||
  st.pingLog !== prev.pingLog ||
  (st.rooms !== prev.rooms && inputsOf.rooms(st) !== inputsOf.rooms(prev)) ||
  (st.servers !== prev.servers && inputsOf.servers(st) !== inputsOf.servers(prev)) ||
  (st.contacts !== prev.contacts && inputsOf.contacts(st) !== inputsOf.contacts(prev))

// Keeps the listed pings up to date (counted again `inbox.recountMs` after a change); returns
// the cleanup.
export const startP2pPings = (account: AccountSession, app: P2pApp, delay?: number) => {
  if (app.owner !== account) throw new Error('P2P inbox owner mismatch')
  const { useP2p, p2p } = app
  const listed = listedStore(app)
  let stopped = false
  let checked: Checked = new Map()
  let mark = account.lifetime.sessionMark()
  let run = 0
  let timer: ReturnType<typeof setTimeout> | null = null
  const recount = () => {
    timer = null
    const mine = ++run
    if (mark !== account.lifetime.sessionMark()) {
      checked = new Map()
      mark = account.lifetime.sessionMark()
    }
    const current = mark
    const loaded = useP2p.getState().countsLoaded
    void listedPings(checked, app).then(
      by => {
        if (
          mine === run &&
          current === account.lifetime.sessionMark() &&
          loaded === useP2p.getState().countsLoaded
        )
          listed.setState({ by: by ?? new Map(), loaded: by ? loaded : null })
      },
      () => {}
    )
  }
  const off = useP2p.subscribe((st, prev) => {
    if (!timer && pingInputsChanged(st, prev))
      timer = setTimeout(recount, delay ?? p2p.limits().inbox.recountMs)
  })
  recount()
  return () => {
    if (stopped) return
    stopped = true
    off()
    if (timer) clearTimeout(timer)
    run += 1
    listed.setState({ by: new Map() })
  }
}

const actorName = (st: P2pState, p: PingRec, app: P2pApp) => {
  if (p.ch !== null) return app.memberName(p.room, p.actor)
  const c = st.contacts.find(x => x.ik === p.actor)
  return c ? displayName(c) : 'Someone'
}

// P2P mentions, @everyone, replies and reactions, from the pings this browser noted.
export const createP2pInbox = (
  account: AccountSession,
  app: P2pApp,
  live: () => boolean = () => true
): InboxAdapter => {
  if (app.owner !== account) throw new Error('P2P inbox owner mismatch')
  const { useP2p, p2pPings, p2pOpenAt, p2p } = app
  const listed = listedStore(app)
  const id = `${P2P_INBOX}:${encodeURIComponent(app.localId)}`
  const active = () => live() && app.isCurrent()
  const owns = (entry: InboxEntry) => entry.adapter === id
  return {
    id,
    canPreview: entry => {
      const p = entry.raw as PingRec
      return active() && owns(entry) && (!p.ch || app.peerVisible(useP2p.getState(), p.room, p.ch))
    },
    previewTarget: entry => {
      const p = entry.raw as PingRec
      return active() && owns(entry) && p.ch
        ? (app.peerTarget(useP2p.getState(), p.room, p.ch) ?? null)
        : null
    },
    load: async (view, cursor) => {
      const mark = account.lifetime.sessionMark()
      const snap = active() ? await p2pPings.read() : null
      const st = useP2p.getState()
      if (!active() || mark !== account.lifetime.sessionMark() || !snap || !st.enabled)
        return { entries: [], next: null }
      const w = worldOf(st, snap.readSeq)
      const prefs = account.store.getState().notifyPrefs
      const list = snap.list.filter(listedIn(view, w, prefs)).sort(newerFirst)
      const { page, next } = pagePings(list, cursor, p2p.limits().inbox.pageSize)
      const texts = await Promise.all(page.map(p => p2pPings.text(p)))
      if (!active() || mark !== account.lifetime.sessionMark()) return { entries: [], next: null }
      const entries = page.flatMap((p, i) => {
        const t = texts[i]
        if (!t) return []
        return [{ ...pingEntry(p, w, actorName(st, p, app), t), adapter: id, key: `${id}:${p.id}` }]
      })
      return { entries, next }
    },
    markRead: async entry => {
      if (active() && owns(entry)) await p2pPings.mark([(entry.raw as PingRec).id])
    },
    markAll: async (view, shown) => {
      const mark = account.lifetime.sessionMark()
      const snap = active() ? await p2pPings.read() : null
      if (!active() || mark !== account.lifetime.sessionMark() || !snap) return
      const w = worldOf(useP2p.getState(), snap.readSeq)
      const list = snap.list.filter(listedIn(view, w, account.store.getState().notifyPrefs))
      const recs = shown.filter(owns).map(e => e.raw as PingRec)
      await p2pPings.mark(markAllTargets(list, view, recs, snap.readSeq).map(p => p.id))
    },
    open: entry => {
      const p = entry.raw as PingRec
      if (!active() || !owns(entry)) return
      account.identities.show(app)
      return p2pOpenAt(p.room, p.ch, p.kind === 'reaction' ? (p.target ?? p.id) : p.id)
    },
    countReady: () => {
      const loaded = useP2p.getState().countsLoaded
      return active() && !!loaded && listed.getState().loaded === loaded
    },
    count: () =>
      active()
        ? p2pPingCount(
            useP2p.getState(),
            account.store.getState().notifyPrefs,
            listed.getState().by
          )
        : 0,
    subscribe: onChange => {
      const offP2p = useP2p.subscribe((st, prev) => {
        if (
          st.rooms !== prev.rooms ||
          st.servers !== prev.servers ||
          st.countsLoaded !== prev.countsLoaded ||
          st.enabled !== prev.enabled
        )
          onChange()
      })
      const offListed = listed.subscribe(onChange)
      const offPrefs = account.store.subscribe((st, prev) => {
        if (st.notifyPrefs !== prev.notifyPrefs) onChange()
      })
      return () => {
        offP2p()
        offListed()
        offPrefs()
      }
    },
  }
}

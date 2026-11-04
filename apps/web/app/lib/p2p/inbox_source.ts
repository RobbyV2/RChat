import { create } from 'zustand'
import type { InboxAdapter, InboxView } from '../inbox'
import { levelOf, type NotifyPrefs } from '../notify'
import { useStore } from '../store'
import { memberName, p2pOpenAt, p2pPings, useP2p, type P2pState } from './app'
import { displayName } from './contacts'
import { LOCAL } from './limits'
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

const PAGE_SIZE = LOCAL.inbox.pageSize
const RECOUNT_MS = LOCAL.inbox.recountMs

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
let checked = new Map<string, { seq: number; ok: boolean }>()

// Unread pings the list can show, by counter (`{room}` or `{room}/{channel}`).
export const listedPings = async (): Promise<Map<string, number>> => {
  const snap = await p2pPings.read()
  const st = useP2p.getState()
  if (!snap || !st.enabled) return new Map()
  const w = worldOf(st, snap.readSeq)
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
  checked = next
  return byCounter(rows.filter((_, i) => ok[i]))
}

export const useListedPings = create<{ by: ReadonlyMap<string, number> }>(() => ({
  by: new Map(),
}))

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
          `${v.id}:${v.me}:${v.seq}:${v.channels.map(c => c.id).join('/')}:${Object.entries(v.chans)
            .map(([ch, c]) => `${ch}=${c.pings}/${c.readSeq}`)
            .join('/')}`
      )
      .join(),
  contacts: (st: P2pState) => st.contacts.map(c => `${c.ik}:${c.state}`).join(),
}

// What the listed pings depend on changed: the log, read positions, counters, stored content,
// places or contacts (not typing or presence).
export const pingInputsChanged = (st: P2pState, prev: P2pState) =>
  st.enabled !== prev.enabled ||
  st.me !== prev.me ||
  st.pingLog !== prev.pingLog ||
  (st.rooms !== prev.rooms && inputsOf.rooms(st) !== inputsOf.rooms(prev)) ||
  (st.servers !== prev.servers && inputsOf.servers(st) !== inputsOf.servers(prev)) ||
  (st.contacts !== prev.contacts && inputsOf.contacts(st) !== inputsOf.contacts(prev))

// Keeps the listed pings up to date; returns the cleanup.
export const startP2pPings = (recountMs = RECOUNT_MS) => {
  let run = 0
  let timer: ReturnType<typeof setTimeout> | null = null
  const recount = () => {
    timer = null
    const mine = ++run
    void listedPings().then(
      by => {
        if (mine === run) useListedPings.setState({ by })
      },
      () => {}
    )
  }
  const off = useP2p.subscribe((st, prev) => {
    if (!timer && pingInputsChanged(st, prev)) timer = setTimeout(recount, recountMs)
  })
  recount()
  return () => {
    off()
    if (timer) clearTimeout(timer)
    run += 1
    useListedPings.setState({ by: new Map() })
  }
}

const actorName = (st: P2pState, p: PingRec) => {
  if (p.ch !== null) return memberName(p.room, p.actor)
  const c = st.contacts.find(x => x.ik === p.actor)
  return c ? displayName(c) : 'Someone'
}

// P2P mentions, @everyone, replies and reactions, from the pings this browser noted.
export const p2pInbox: InboxAdapter = {
  id: P2P_INBOX,
  load: async (view, cursor) => {
    const snap = await p2pPings.read()
    const st = useP2p.getState()
    if (!snap || !st.enabled) return { entries: [], next: null }
    const w = worldOf(st, snap.readSeq)
    const prefs = useStore.getState().notifyPrefs
    const list = snap.list.filter(listedIn(view, w, prefs)).sort(newerFirst)
    const { page, next } = pagePings(list, cursor, PAGE_SIZE)
    const texts = await Promise.all(page.map(p => p2pPings.text(p)))
    const entries = page.flatMap((p, i) => {
      const t = texts[i]
      return t ? [pingEntry(p, w, actorName(st, p), t)] : []
    })
    return { entries, next }
  },
  markRead: entry => p2pPings.mark([(entry.raw as PingRec).id]),
  markAll: async (view, shown) => {
    const snap = await p2pPings.read()
    if (!snap) return
    const w = worldOf(useP2p.getState(), snap.readSeq)
    const list = snap.list.filter(listedIn(view, w, useStore.getState().notifyPrefs))
    const recs = shown.map(e => e.raw as PingRec)
    await p2pPings.mark(markAllTargets(list, view, recs, snap.readSeq).map(p => p.id))
  },
  open: entry => {
    const p = entry.raw as PingRec
    return p2pOpenAt(p.room, p.ch, p.kind === 'reaction' ? (p.target ?? p.id) : p.id)
  },
  count: () =>
    p2pPingCount(useP2p.getState(), useStore.getState().notifyPrefs, useListedPings.getState().by),
  subscribe: onChange => {
    const offP2p = useP2p.subscribe((st, prev) => {
      if (st.rooms !== prev.rooms || st.servers !== prev.servers) onChange()
    })
    const offListed = useListedPings.subscribe(onChange)
    const offPrefs = useStore.subscribe((st, prev) => {
      if (st.notifyPrefs !== prev.notifyPrefs) onChange()
    })
    return () => {
      offP2p()
      offListed()
      offPrefs()
    }
  },
}

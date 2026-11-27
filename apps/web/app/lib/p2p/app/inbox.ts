import type { MarkAllExtra } from '../../store_types'
import { p2pUnread } from '../alerts'
import { isEventId, readFwdSrc, type EditContent, type MsgContent } from '../content'
import { displayName } from '../contacts'
import type { EventRecord, P2pStore } from '../db'
import { textHash, vouchedFiles, type HeldOriginal } from '../../forward_pill'
import type { UserRef } from '../../types'
import { loadMessages, type P2pMessage } from '../dm'
import type { PingRec, PingText } from '../inbox'
import { pingAlive, pingText, readPings } from '../ping_log'
import type { P2pState } from './store'
import type { P2pParts } from './scope'

export function createInboxPart(
  parts: Pick<P2pParts, 'viewing' | 'store' | 'dms' | 'calls' | 'servers' | 'account'>
) {
  const state = parts.store
  const { useP2p, p2pHost } = state

  // ----- Inbox -----

  const pingLogged = () => {
    state.data?.postMessage({ inbox: true })
    useP2p.setState(st => ({ pingLog: st.pingLog + 1 }))
  }

  const p2pPings = {
    // The noted pings and the read positions, from the running node's database or the stored one.
    async read(): Promise<{ list: PingRec[]; readSeq: Map<string, number> } | null> {
      const s = parts.dms.dbNow()
      if (!s) return null
      try {
        return state.pingLog && state.store === s ? await state.pingLog.read() : await readPings(s)
      } catch {
        return null
      }
    },

    async text(p: PingRec): Promise<PingText | null> {
      const s = parts.dms.dbNow()
      if (p.ch && !parts.viewing.peerVisible(useP2p.getState(), p.room, p.ch)) return null
      return s ? pingText(s, p) : null
    },

    async alive(p: PingRec) {
      const s = parts.dms.dbNow()
      if (p.ch && !parts.viewing.peerVisible(useP2p.getState(), p.room, p.ch)) return false
      return s ? pingAlive(s, p) : false
    },

    // Marks pings read. Only the tab that runs P2P writes.
    async mark(ids: string[]) {
      if (!ids.length) return
      if (!state.pingLog) {
        if (useP2p.getState().enabled) p2pHost.toast(parts.calls.ELSEWHERE_TEXT)
        return
      }
      await state.pingLog.mark(ids)
    },
  }

  // What "Mark all as read" adds for P2P: conversations and joined servers that show unread, as
  // Home's Unread card lists them.
  const p2pMarkAll = (): MarkAllExtra => {
    const u = p2pUnread(useP2p.getState(), p2pHost.prefs(), Date.now())
    return {
      pending: u.dms.unread || u.dms.pings > 0 || u.servers.length > 0,
      mark: () => {
        parts.dms.p2pDm.markAllRead()
        for (const v of Object.values(useP2p.getState().servers))
          if (v.me === 'join') parts.servers.p2pServer.markAllRead(v.id)
      },
    }
  }

  // Opens a conversation or server channel at a message.
  const p2pOpenAt = async (room: string, ch: string | null, id: string) => {
    if (ch === null) {
      const peer = useP2p.getState().rooms[room]?.peer
      if (!peer) return
      parts.account.p2p.openHome()
      await parts.dms.p2pDm.openDm(peer)
    } else {
      if (!(await parts.servers.p2pServer.open(room, ch))) return
      await channelLoaded(room, ch)
    }
    const chat = useP2p.getState().chat
    if (chat?.room !== room || (chat.ch ?? null) !== ch) return
    const root = ch === null ? null : await state.servers?.threadOf(id).catch(() => null)
    if (root) {
      await parts.dms.p2pDm.jumpTo(root)
      await parts.servers.p2pThread.open(root, id)
    } else await parts.dms.p2pDm.jumpTo(id)
  }

  const channelLoaded = (room: string, ch: string) =>
    new Promise<void>(resolve => {
      const done = (st: P2pState) => st.chat?.room !== room || st.chat.ch !== ch || !st.chat.loading
      if (done(useP2p.getState())) return resolve()
      const stop = () => {
        clearTimeout(timer)
        off()
        resolve()
      }
      const off = useP2p.subscribe(st => {
        if (done(st)) stop()
      })
      const timer = setTimeout(stop, 5000)
    })

  // The newest page of a conversation or channel as stored here (the palette's index).
  const p2pRecent = async (room: string, ch: string | null): Promise<P2pMessage[] | null> => {
    const s = parts.dms.dbNow()
    const me = parts.dms.meNow()
    if (!s || !me || (ch && !parts.viewing.peerVisible(useP2p.getState(), room, ch))) return null
    const limit = state.limits.dm.page
    try {
      if (ch !== null)
        return state.servers
          ? (await state.servers.loadChannel(room, ch, { limit })).messages
          : null
      const peer = useP2p.getState().rooms[room]?.peer
      return peer
        ? (await loadMessages(s.db, room, me, peer, { limit }, state.limits)).messages
        : null
    } catch {
      return null
    }
  }
  // What this identity holds of a message, by its event id: a live message in one of its
  // conversations, or in a channel of one of its servers that it sees, with what it says. Read
  // once per id, and again when an edit or a redaction aimed at it (or at an original it copies)
  // arrives; whether it shows follows the current state.
  const HELD_MAX = 500
  const CHAIN_MAX = 3
  const held = new Map<string, { at: HeldOriginal | null; watch: string[] }>()
  const heldFns = new Set<() => void>()
  let heldRev = 0

  const remember = (ev: string, at: HeldOriginal | null, watch: string[]) => {
    held.delete(ev)
    if (held.size >= HELD_MAX) held.delete(held.keys().next().value!)
    held.set(ev, { at, watch })
  }

  const shown = (st: P2pState, at: HeldOriginal | null | undefined) => {
    if (!at) return at
    if (at.ch === null) return st.rooms[at.room] ? at : null
    return parts.viewing.peerTarget(st, at.room, at.ch) ? at : null
  }

  // A copy held as an original vouches only when its own original, which this identity holds
  // and sees, vouches for it, up to CHAIN_MAX copies deep. `chain` collects the copies and
  // originals read; `watch` those and the edits read, which a redaction may take back.
  const readHeld = async (
    s: P2pStore,
    ev: string,
    chain: string[],
    watch: string[]
  ): Promise<HeldOriginal | null> => {
    chain.push(ev)
    watch.push(ev)
    const rec = await s.event(ev).catch(() => undefined)
    const c =
      rec?.type === 'msg' && !rec.redacted && !rec.purged ? (rec.wire.c as MsgContent | null) : null
    if (!rec || !c) return null
    const ch = rec.chan ?? null
    if (c.fwd) {
      const inner = readFwdSrc(c.fwd)
      if (!inner.ev || chain.length >= CHAIN_MAX || chain.includes(inner.ev)) return null
      const first = shown(useP2p.getState(), await readHeld(s, inner.ev, chain, watch))
      const atts = first && vouchedFiles(inner, first)
      if (!first || !atts) return null
      return {
        room: rec.room,
        ch,
        sender: first.sender,
        ts: [inner.ts],
        texts: [textHash(inner.body)],
        atts,
      }
    }
    const related = await s.db
      .getAllFromIndex('events', 'room_target', [rec.room, ev])
      .catch(() => [] as EventRecord[])
    const edits = related.flatMap(e => {
      if (e.type !== 'edit' || e.sender !== rec.sender) return []
      watch.push(e.id)
      const body = (e.wire.c as EditContent | null)?.body
      return !e.redacted && typeof body === 'string' ? [textHash(body)] : []
    })
    return {
      room: rec.room,
      ch,
      sender: rec.sender,
      ts: [rec.wire.ev.ts, rec.effTs],
      texts: [textHash(c.body), ...edits],
      atts: c.att ?? [],
    }
  }

  const readAgain = async (ev: string) => {
    const s = parts.dms.dbNow()
    if (!s || !isEventId(ev)) return null
    const watch: string[] = []
    const at = await readHeld(s, ev, [], watch)
    if (parts.dms.dbNow() !== s) return null
    const was = held.get(ev)
    remember(ev, at, watch)
    if (!was || JSON.stringify(was.at) !== JSON.stringify(at)) {
      heldRev += 1
      for (const fn of heldFns) fn()
    }
    return shown(useP2p.getState(), at) ?? null
  }

  // An original found before is not read again here; one not found yet (it may arrive later) is.
  const locateEvent = async (ev: string) => {
    const known = held.get(ev)?.at
    return known ? (shown(useP2p.getState(), known) ?? null) : readAgain(ev)
  }

  // What the last look found, without looking again: undefined before the first answer.
  const eventPlace = (ev: string) => shown(useP2p.getState(), held.get(ev)?.at)

  // Edits and redactions aimed at `targets` arrived: the originals they touch are read again.
  const heldTouched = (targets: string[]) => {
    for (const [ev, entry] of held)
      if (entry.watch.some(id => targets.includes(id))) void readAgain(ev)
  }

  const onHeld = (fn: () => void) => {
    heldFns.add(fn)
    return () => void heldFns.delete(fn)
  }

  // The original's author as this identity names them: a contact's petname first, then the name
  // a server member or the author gives themselves.
  const heldAuthor = (at: HeldOriginal): UserRef => {
    const st = useP2p.getState()
    const c = st.contacts.find(x => x.ik === at.sender)
    const room = at.ch === null ? undefined : at.room
    const member = c || !room ? undefined : st.servers[room]?.members.find(m => m.ik === at.sender)
    const name = c ? displayName(c) : member?.name || parts.servers.profileName(at.sender, room)
    return parts.dms.p2pUser(at.sender, name)
  }

  return {
    pingLogged,
    p2pPings,
    p2pMarkAll,
    p2pOpenAt,
    channelLoaded,
    p2pRecent,
    locateEvent,
    eventPlace,
    heldTouched,
    onHeld,
    heldRevision: () => heldRev,
    heldAuthor,
  }
}

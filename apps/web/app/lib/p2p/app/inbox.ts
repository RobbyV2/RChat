import type { MarkAllExtra } from '../../store_types'
import { p2pUnread } from '../alerts'
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
  return { pingLogged, p2pPings, p2pMarkAll, p2pOpenAt, channelLoaded, p2pRecent }
}

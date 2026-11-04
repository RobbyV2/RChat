import type { MarkAllExtra } from '../../store_types'
import { p2pUnread } from '../alerts'
import { loadMessages, PAGE, type P2pMessage } from '../dm'
import type { PingRec, PingText } from '../inbox'
import { pingAlive, pingText, readPings } from '../ping_log'
import { data, useP2p, pingLog, store, p2pHost, servers, type P2pState } from './store'
import { dbNow, p2pDm, meNow } from './dms'
import { ELSEWHERE_TEXT } from './calls'
import { p2pServer, p2pThread } from './servers'
import { p2p } from './account'

// ----- Inbox -----

export const pingLogged = () => {
  data?.postMessage({ inbox: true })
  useP2p.setState(st => ({ pingLog: st.pingLog + 1 }))
}

export const p2pPings = {
  // The noted pings and the read positions, from the running node's database or the stored one.
  async read(): Promise<{ list: PingRec[]; readSeq: Map<string, number> } | null> {
    const s = dbNow()
    if (!s) return null
    try {
      return pingLog && store === s ? await pingLog.read() : await readPings(s)
    } catch {
      return null
    }
  },

  async text(p: PingRec): Promise<PingText | null> {
    const s = dbNow()
    return s ? pingText(s, p) : null
  },

  async alive(p: PingRec) {
    const s = dbNow()
    return s ? pingAlive(s, p) : false
  },

  // Marks pings read. Only the tab that runs P2P writes.
  async mark(ids: string[]) {
    if (!ids.length) return
    if (!pingLog) {
      if (useP2p.getState().enabled) p2pHost.toast(ELSEWHERE_TEXT)
      return
    }
    await pingLog.mark(ids)
  },
}

// What "Mark all as read" adds for P2P: conversations and joined servers that show unread, as
// Home's Unread card lists them.
export const p2pMarkAll = (): MarkAllExtra => {
  const u = p2pUnread(useP2p.getState(), p2pHost.prefs(), Date.now())
  return {
    pending: u.dms.unread || u.dms.pings > 0 || u.servers.length > 0,
    mark: () => {
      p2pDm.markAllRead()
      for (const v of Object.values(useP2p.getState().servers))
        if (v.me === 'join') p2pServer.markAllRead(v.id)
    },
  }
}

// Opens a conversation or server channel at a message.
export const p2pOpenAt = async (room: string, ch: string | null, id: string) => {
  if (ch === null) {
    const peer = useP2p.getState().rooms[room]?.peer
    if (!peer) return
    p2p.openHome()
    await p2pDm.openDm(peer)
  } else {
    p2pServer.open(room, ch)
    await channelLoaded(room, ch)
  }
  const chat = useP2p.getState().chat
  if (chat?.room !== room || (chat.ch ?? null) !== ch) return
  const root = ch === null ? null : await servers?.threadOf(id).catch(() => null)
  if (root) {
    await p2pDm.jumpTo(root)
    await p2pThread.open(root, id)
  } else await p2pDm.jumpTo(id)
}

export const channelLoaded = (room: string, ch: string) =>
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
export const p2pRecent = async (room: string, ch: string | null): Promise<P2pMessage[] | null> => {
  const s = dbNow()
  const me = meNow()
  if (!s || !me) return null
  try {
    if (ch !== null)
      return servers ? (await servers.loadChannel(room, ch, { limit: PAGE })).messages : null
    const peer = useP2p.getState().rooms[room]?.peer
    return peer ? (await loadMessages(s.db, room, me, peer, { limit: PAGE })).messages : null
  } catch {
    return null
  }
}

import type { IndexDoc, PaletteIndex } from '../palette_index'
import {
  dropIndexBucket,
  dropIndexIn,
  dropIndexWhere,
  indexDocs,
  paletteIndex,
  registerIndexSource,
  useIndexStatus,
  type IndexSource,
} from '../palette_sync'
import { replaceSpoilers } from '../spoilers'
import { memberName, p2pOpenAt, p2pRecent, useP2p, type P2pState } from './app'
import { displayName } from './contacts'
import type { P2pMessage } from './dm'

// P2P conversations and server channels in the palette's index: messages as this browser loads
// them, and in "Full" mode the newest stored page of each conversation and channel. Documents
// carry `source: 'p2p'` and a bucket per place (`p:{room}` or `p:{room}/{channel}`); they never
// name an instance server, so nothing about them reaches the instance. They show only while the
// place is still open to the user, and go when P2P data is removed or the account changes.

export const P2P_SOURCE = 'p2p'

export const p2pBucket = (room: string, ch: string | null) =>
  ch === null ? `p:${room}` : `p:${room}/${ch}`

export const bucketPlace = (bucket: string): { room: string; ch: string | null } | null => {
  if (!bucket.startsWith('p:')) return null
  const rest = bucket.slice(2)
  const i = rest.indexOf('/')
  if (!rest || i === 0) return null
  return i < 0 ? { room: rest, ch: null } : { room: rest.slice(0, i), ch: rest.slice(i + 1) }
}

const blank = '███'

// A message's document; system rows, call rows and empty messages have none.
export const p2pDoc = (
  room: string,
  ch: string | null,
  m: P2pMessage,
  name: string
): IndexDoc | null => {
  if (m.system || m.call) return null
  // Spoiler text is never indexed, so a search can't confirm what a spoiler hides.
  const text = replaceSpoilers(m.fwd ? m.fwd.body : m.body, () => blank).trim()
  if (!text) return null
  return {
    id: `p${m.id}`,
    kind: 'message',
    bucket: p2pBucket(room, ch),
    source: P2P_SOURCE,
    server: null,
    channel: null,
    dm: null,
    thread: null,
    msg: null,
    author: m.sender,
    name,
    text,
    at: Math.floor(m.ts / 1000),
  }
}

const blocked = (st: P2pState, ik: string) =>
  st.contacts.some(c => c.ik === ik && c.state === 'blocked')

// Whether a document's place is open to the user now: a conversation with a contact who isn't
// blocked, or a channel of a server they are still in. Nothing by blocked contacts.
export const p2pDocVisible = (st: P2pState, d: IndexDoc) => {
  const at = bucketPlace(d.bucket)
  if (!at || !st.enabled || blocked(st, d.author)) return false
  if (at.ch === null) {
    const peer = st.rooms[at.room]?.peer
    return !!peer && st.contacts.some(c => c.ik === peer) && !blocked(st, peer)
  }
  const v = st.servers[at.room]
  return !!v && v.me === 'join' && v.channels.some(c => c.id === at.ch)
}

export const p2pDocPlace = (st: P2pState, d: IndexDoc) => {
  const at = bucketPlace(d.bucket)
  if (!at) return ''
  if (at.ch === null) return 'P2P direct message'
  const v = st.servers[at.room]
  const ch = v?.channels.find(c => c.id === at.ch)?.name ?? 'channel'
  return `#${ch} · ${v?.name ?? 'P2P server'}`
}

const nameIn = (st: P2pState, room: string, ch: string | null, ik: string) => {
  if (ch !== null) return memberName(room, ik)
  if (ik === st.me) return st.name || 'You'
  const c = st.contacts.find(x => x.ik === ik)
  return c ? displayName(c) : 'Contact'
}

const docsOf = (st: P2pState, room: string, ch: string | null, list: readonly P2pMessage[]) =>
  list.flatMap(m =>
    blocked(st, m.sender) ? [] : (p2pDoc(room, ch, m, nameIn(st, room, ch, m.sender)) ?? [])
  )

// A run of a place's messages replaces what the index has in that time range: deleted messages,
// and those edited to nothing, go.
export const reconcilePlace = (
  st: P2pState,
  room: string,
  ch: string | null,
  list: readonly P2pMessage[]
) => {
  const bucket = p2pBucket(room, ch)
  const docs = docsOf(st, room, ch, list)
  const shown = list.filter(m => !m.call && !m.system)
  if (shown.length) {
    const lo = Math.floor(shown[0].ts / 1000)
    const hi = Math.floor(shown[shown.length - 1].ts / 1000)
    const keep = new Set(docs.map(d => d.id))
    dropIndexIn(bucket, d => d.at >= lo && d.at <= hi && !keep.has(d.id))
  }
  indexDocs(docs)
}

export const p2pIndexSource: IndexSource = {
  id: P2P_SOURCE,
  visible: d => p2pDocVisible(useP2p.getState(), d),
  open: d => {
    const at = bucketPlace(d.bucket)
    if (at) void p2pOpenAt(at.room, at.ch, d.id.slice(1))
  },
  place: d => p2pDocPlace(useP2p.getState(), d),
}

const dropAll = () => dropIndexWhere(d => d.source === P2P_SOURCE)

// The places to fill in "Full" mode: conversations with contacts and text channels of servers
// the user is in.
export const placesOf = (st: Pick<P2pState, 'rooms' | 'servers' | 'contacts'>) => {
  const out: { room: string; ch: string | null }[] = []
  for (const r of Object.values(st.rooms))
    if (st.contacts.some(c => c.ik === r.peer && c.state === 'mutual'))
      out.push({ room: r.id, ch: null })
  for (const v of Object.values(st.servers))
    if (v.me === 'join')
      for (const c of v.channels) if (c.kind === 'text') out.push({ room: v.id, ch: c.id })
  return out
}

const GAP_MS = 50
const REFRESH_MS = 5000

const wait = (ms: number) => new Promise(r => setTimeout(r, ms))

// Places whose stored content changed (messages, edits, deletions, channels, membership): their
// newest event moved. Typing, presence and delivery don't move it.
export const changedRooms = (
  prev: Pick<P2pState, 'rooms' | 'servers'>,
  st: Pick<P2pState, 'rooms' | 'servers'>
) => {
  const out = new Set<string>()
  if (st.rooms !== prev.rooms)
    for (const [room, r] of Object.entries(st.rooms)) {
      const was = prev.rooms[room]
      if (was && was.seq !== r.seq) out.add(room)
    }
  if (st.servers !== prev.servers)
    for (const [room, v] of Object.entries(st.servers)) {
      const was = prev.servers[room]
      if (was && was.seq !== v.seq) out.add(room)
    }
  return out
}

// Follows P2P and the palette index; returns the cleanup.
export const startP2pIndex = ({ recent = p2pRecent, refreshMs = REFRESH_MS } = {}) => {
  let ix: PaletteIndex | null = null
  let run = 0
  // The message list of the open place last indexed, and the places filled from storage.
  let seen: readonly P2pMessage[] | null = null
  let filled = new Set<string>()
  const dirty = new Set<string>()
  let timer: ReturnType<typeof setTimeout> | null = null

  const indexChat = (st: P2pState) => {
    const chat = st.chat
    if (!ix || !chat || chat.loading || chat.messages === seen) return
    seen = chat.messages
    reconcilePlace(st, chat.room, chat.ch ?? null, chat.messages)
  }

  // Stored pages of places, one at a time.
  const fill = async (places: { room: string; ch: string | null }[]) => {
    const mine = run
    for (const p of places) {
      if (mine !== run || !ix) return
      const list = await recent(p.room, p.ch)
      if (mine !== run || !ix) return
      if (list) reconcilePlace(useP2p.getState(), p.room, p.ch, list)
      await wait(GAP_MS)
    }
  }

  // "Full" mode: every place not filled yet.
  const backfill = () => {
    const st = useP2p.getState()
    if (!ix || useIndexStatus.getState().mode !== 'full' || !st.me) return
    const todo = placesOf(st).filter(p => !filled.has(p2pBucket(p.room, p.ch)))
    for (const p of todo) filled.add(p2pBucket(p.room, p.ch))
    if (todo.length) void fill(todo)
  }

  // Indexed places whose stored content changed, other than the open one: their stored page
  // again (edits, deletions).
  const refresh = () => {
    timer = null
    const have = new Set(paletteIndex()?.bucketNames() ?? [])
    const st = useP2p.getState()
    const open = st.chat && p2pBucket(st.chat.room, st.chat.ch ?? null)
    const places = placesOf(st).filter(p => {
      const b = p2pBucket(p.room, p.ch)
      return dirty.has(p.room) && have.has(b) && b !== open
    })
    dirty.clear()
    void fill(places)
  }

  const drop = (bucket: string) => {
    filled.delete(bucket)
    dropIndexBucket(bucket)
  }

  const dropRoom = (room: string) => {
    for (const b of paletteIndex()?.bucketNames() ?? [])
      if (b === p2pBucket(room, null) || b.startsWith(`p:${room}/`)) drop(b)
  }

  const reset = () => {
    run += 1
    seen = null
    filled = new Set()
    dirty.clear()
  }

  const offIndex = useIndexStatus.subscribe(() => {
    const next = paletteIndex()
    if (next !== ix) {
      ix = next
      reset()
      if (ix) indexChat(useP2p.getState())
    }
    backfill()
  })

  const offP2p = useP2p.subscribe((st, prev) => {
    const removed =
      st.account !== prev.account ||
      (prev.enabled && !st.enabled) ||
      (prev.me !== null && st.me !== null && prev.me !== st.me)
    if (removed) {
      reset()
      dropAll()
    }
    if (!ix) return
    // Left, removed, banned or forgotten here (not a tab handing P2P over).
    const same = st.me !== null && prev.me !== null && st.reader === prev.reader
    for (const [room, v] of same ? Object.entries(prev.servers) : []) {
      const now = st.servers[room]
      if (!now || (v.me === 'join' && (now.me === 'leave' || now.me === 'ban'))) dropRoom(room)
      else if (now.channels !== v.channels)
        for (const c of v.channels)
          if (!now.channels.some(x => x.id === c.id)) drop(p2pBucket(room, c.id))
    }
    if (st.contacts !== prev.contacts) {
      const rooms = Object.values({ ...prev.rooms, ...st.rooms })
      const dropDm = (ik: string) => {
        for (const r of rooms) if (r.peer === ik) drop(p2pBucket(r.id, null))
      }
      for (const c of st.contacts)
        if (
          c.state === 'blocked' &&
          !prev.contacts.some(x => x.ik === c.ik && x.state === 'blocked')
        ) {
          dropIndexWhere(d => d.source === P2P_SOURCE && d.author === c.ik)
          dropDm(c.ik)
        }
      for (const c of same ? prev.contacts : [])
        if (!st.contacts.some(x => x.ik === c.ik)) dropDm(c.ik)
    }
    for (const room of changedRooms(prev, st)) dirty.add(room)
    if (dirty.size && !timer) timer = setTimeout(refresh, refreshMs)
    if (st.chat !== prev.chat) indexChat(st)
    if (st.rooms !== prev.rooms || st.servers !== prev.servers || st.contacts !== prev.contacts)
      backfill()
  })

  const offSource = registerIndexSource(p2pIndexSource)
  ix = paletteIndex()
  if (ix) indexChat(useP2p.getState())
  backfill()
  return () => {
    reset()
    if (timer) clearTimeout(timer)
    offIndex()
    offP2p()
    offSource()
  }
}

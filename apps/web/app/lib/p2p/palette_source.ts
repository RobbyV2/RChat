import type { IndexDoc, PaletteIndex } from '../palette_index'
import type { AccountSession } from '../client/session'
import type { IndexSource } from '../palette_sync'
import { replaceSpoilers } from '../spoilers'
import type { P2pState } from './app'
import { type P2pApp } from './app/runtime'
import { displayName } from './contacts'
import type { P2pMessage } from './dm'

// P2P conversations and server channels in the palette's index: messages as this browser loads
// them, and in "Full" mode the newest stored page of each conversation and channel. Documents
// use a bucket per place and an identity-specific namespace when bound to an app. They never
// name an instance server, so nothing about them reaches the instance. They show only while the
// place is still open to the user, and go when P2P data is removed or the account changes.

export const P2P_SOURCE = 'p2p'

// Each account has its own palette index. Its main identity keeps the on-disk IDs.
const sourceId = (app?: P2pApp) =>
  app && app.localId !== 'main' ? `${P2P_SOURCE}:${encodeURIComponent(app.localId)}` : P2P_SOURCE
const docPrefix = (app?: P2pApp) => {
  const source = sourceId(app)
  return source === P2P_SOURCE ? 'p' : source + ':'
}
const bucketPrefix = (app?: P2pApp) => {
  const source = sourceId(app)
  return source === P2P_SOURCE ? 'p:' : source + ':'
}

export const p2pBucket = (room: string, ch: string | null, app?: P2pApp) =>
  bucketPrefix(app) + (ch === null ? room : `${room}/${ch}`)

export const bucketPlace = (
  bucket: string,
  app?: P2pApp
): { room: string; ch: string | null } | null => {
  const prefix = bucketPrefix(app)
  if (!bucket.startsWith(prefix)) return null
  const rest = bucket.slice(prefix.length)
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
  name: string,
  app?: P2pApp
): IndexDoc | null => {
  if (m.system || m.call) return null
  // Spoiler text is never indexed, so a search can't confirm what a spoiler hides.
  const text = replaceSpoilers(m.fwd ? m.fwd.body : m.body, () => blank).trim()
  if (!text) return null
  return {
    id: docPrefix(app) + m.id,
    kind: 'message',
    bucket: p2pBucket(room, ch, app),
    source: sourceId(app),
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
export const p2pDocVisible = (st: P2pState, d: IndexDoc, app: P2pApp) => {
  const at = bucketPlace(d.bucket, app)
  if (!at || !st.enabled || blocked(st, d.author)) return false
  if (at.ch === null) {
    const peer = st.rooms[at.room]?.peer
    return !!peer && st.contacts.some(c => c.ik === peer) && !blocked(st, peer)
  }
  const v = st.servers[at.room]
  return !!v && v.me === 'join' && app.peerVisible(st, at.room, at.ch)
}

export const p2pDocPlace = (st: P2pState, d: IndexDoc, app: P2pApp) => {
  const at = bucketPlace(d.bucket, app)
  if (!at) return ''
  if (at.ch === null) return 'P2P direct message'
  const v = st.servers[at.room]
  const ch = v?.channels.find(c => c.id === at.ch)?.name ?? 'channel'
  return `#${ch} · ${v?.name ?? 'P2P server'}`
}

const nameIn = (st: P2pState, room: string, ch: string | null, ik: string, app: P2pApp) => {
  if (ch !== null) return app.memberName(room, ik)
  if (ik === st.me) return st.name || 'You'
  const c = st.contacts.find(x => x.ik === ik)
  return c ? displayName(c) : 'Contact'
}

const docsOf = (
  st: P2pState,
  room: string,
  ch: string | null,
  list: readonly P2pMessage[],
  app: P2pApp
) =>
  list.flatMap(m =>
    blocked(st, m.sender)
      ? []
      : (p2pDoc(room, ch, m, nameIn(st, room, ch, m.sender, app), app) ?? [])
  )

// A run of a place's messages replaces what the index has in that time range: deleted messages,
// and those edited to nothing, go.
const reconcilePlace = (
  indexer: AccountSession['indexer'],
  st: P2pState,
  room: string,
  ch: string | null,
  list: readonly P2pMessage[],
  app: P2pApp
) => {
  const bucket = p2pBucket(room, ch, app)
  const docs = docsOf(st, room, ch, list, app)
  const shown = list.filter(m => !m.call && !m.system)
  if (shown.length) {
    const lo = Math.floor(shown[0].ts / 1000)
    const hi = Math.floor(shown[shown.length - 1].ts / 1000)
    const keep = new Set(docs.map(d => d.id))
    indexer.dropIndexIn(bucket, d => d.at >= lo && d.at <= hi && !keep.has(d.id))
  }
  indexer.indexDocs(docs)
}

export const createIndexSource = (app: P2pApp): IndexSource => ({
  id: sourceId(app),
  visible: d => {
    const { useP2p } = app
    return app.isCurrent() && p2pDocVisible(useP2p.getState(), d, app)
  },
  open: d => {
    const at = bucketPlace(d.bucket, app)
    if (!at || !app.isCurrent()) return
    app.owner.identities.show(app)
    void app.p2pOpenAt(at.room, at.ch, d.id.slice(docPrefix(app).length))
  },
  place: d => {
    const { useP2p } = app
    return p2pDocPlace(useP2p.getState(), d, app)
  },
})

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

// Follows P2P and the palette index; returns the cleanup. Stored pages are read `misc.paletteGapMs`
// apart, and changed places again `misc.paletteRefreshMs` after a change.
export const startP2pIndex = (
  account: AccountSession,
  {
    app,
    recent = app.p2pRecent,
    refreshMs,
  }: { app: P2pApp; recent?: P2pApp['p2pRecent']; refreshMs?: number }
) => {
  if (app.owner !== account) throw new Error('P2P palette owner mismatch')
  const { useP2p, p2p } = app
  const source = createIndexSource(app)
  const bucket = (room: string, ch: string | null) => p2pBucket(room, ch, app)
  let stopped = false
  const active = () => !stopped && app.isCurrent()
  const { indexer } = account
  const { dropIndexBucket, dropIndexWhere, paletteIndex, registerIndexSource, useIndexStatus } =
    indexer
  let ix: PaletteIndex | null = null
  let run = 0
  // The message list of the open place last indexed, and the places filled from storage.
  let seen: readonly P2pMessage[] | null = null
  let filled = new Set<string>()
  const dirty = new Set<string>()
  let timer: ReturnType<typeof setTimeout> | null = null

  const indexChat = (st: P2pState) => {
    const chat = st.chat
    if (!active() || !ix || !chat || chat.loading || chat.messages === seen) return
    seen = chat.messages
    reconcilePlace(indexer, st, chat.room, chat.ch ?? null, chat.messages, app)
  }

  // Stored pages of places, one at a time.
  const fill = async (places: { room: string; ch: string | null }[]) => {
    const mine = run
    const mark = account.lifetime.sessionMark()
    for (const p of places) {
      if (!active() || mine !== run || mark !== account.lifetime.sessionMark() || !ix) return
      const list = await recent(p.room, p.ch)
      if (!active() || mine !== run || mark !== account.lifetime.sessionMark() || !ix) return
      if (list) reconcilePlace(indexer, useP2p.getState(), p.room, p.ch, list, app)
      await wait(p2p.limits().misc.paletteGapMs)
    }
  }

  // "Full" mode: every place not filled yet.
  const backfill = () => {
    const st = useP2p.getState()
    if (!active() || !ix || useIndexStatus.getState().mode !== 'full' || !st.me) return
    const todo = placesOf(st).filter(p => !filled.has(bucket(p.room, p.ch)))
    for (const p of todo) filled.add(bucket(p.room, p.ch))
    if (todo.length) void fill(todo)
  }

  // Indexed places whose stored content changed, other than the open one: their stored page
  // again (edits, deletions).
  const refresh = () => {
    timer = null
    const have = new Set(paletteIndex()?.bucketNames() ?? [])
    const st = useP2p.getState()
    const open = st.chat && bucket(st.chat.room, st.chat.ch ?? null)
    const places = placesOf(st).filter(p => {
      const b = bucket(p.room, p.ch)
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
      if (b === bucket(room, null) || b.startsWith(bucket(room, null) + '/')) drop(b)
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
      dropIndexWhere(d => d.source === source.id)
    }
    if (!active() || !ix) return
    // Left, removed, banned or forgotten here (not a tab handing P2P over).
    const same = st.me !== null && prev.me !== null && st.reader === prev.reader
    for (const [room, v] of same ? Object.entries(prev.servers) : []) {
      const now = st.servers[room]
      if (!now || (v.me === 'join' && (now.me === 'leave' || now.me === 'ban'))) dropRoom(room)
      else if (now.channels !== v.channels)
        for (const c of v.channels)
          if (!now.channels.some(x => x.id === c.id)) drop(bucket(room, c.id))
    }
    if (st.contacts !== prev.contacts) {
      const rooms = Object.values({ ...prev.rooms, ...st.rooms })
      const dropDm = (ik: string) => {
        for (const r of rooms) if (r.peer === ik) drop(bucket(r.id, null))
      }
      for (const c of st.contacts)
        if (
          c.state === 'blocked' &&
          !prev.contacts.some(x => x.ik === c.ik && x.state === 'blocked')
        ) {
          dropIndexWhere(d => d.source === source.id && d.author === c.ik)
          dropDm(c.ik)
        }
      for (const c of same ? prev.contacts : [])
        if (!st.contacts.some(x => x.ik === c.ik)) dropDm(c.ik)
    }
    for (const room of changedRooms(prev, st)) dirty.add(room)
    if (dirty.size && !timer)
      timer = setTimeout(refresh, refreshMs ?? p2p.limits().misc.paletteRefreshMs)
    if (st.chat !== prev.chat) indexChat(st)
    if (st.rooms !== prev.rooms || st.servers !== prev.servers || st.contacts !== prev.contacts)
      backfill()
  })

  const offSource = registerIndexSource({
    ...source,
    visible: (doc, state) => active() && source.visible(doc, state),
    open: doc => {
      if (active()) source.open(doc)
    },
  })
  ix = paletteIndex()
  if (ix) indexChat(useP2p.getState())
  backfill()
  return () => {
    if (stopped) return
    stopped = true
    reset()
    if (timer) clearTimeout(timer)
    offIndex()
    offP2p()
    offSource()
    if (app) dropIndexWhere(d => d.source === source.id)
  }
}

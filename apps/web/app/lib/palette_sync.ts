// Keeps the palette index in step with the app: indexes messages and members as the client loads
// them, drops what the viewer loses access to (left, kicked or banned from a server, a channel
// hidden or deleted, deleted messages, blocked people), saves it on this device in "Full" mode and
// backfills recent history there in the background, within the size cap.
//
// Sources: this instance's channels and DMs are the built-in source. Other sources (P2P chats)
// register an adapter with `registerIndexSource` and feed their own documents.

import { create } from 'zustand'
import { ApiError } from './api'
import { api, home } from './instances'
import { blobs } from './platform'
import { replaceSpoilers } from './spoilers'
import type { IndexMode } from './palette'
import {
  FULL_MAX_BYTES,
  LOADED_MAX_BYTES,
  PaletteIndex,
  memberBucket,
  memberDocId,
  messageDocId,
  type IndexDoc,
} from './palette_index'
import { loadPalettePrefs, usePaletteUi } from './palette_store'
import { tapWs, useStore } from './store'
import type { RChatState } from './store_types'
import type { Member, Message, UserRef, WsEvent } from './types'

export interface IndexSource {
  id: string
  // Whether a document of this source may be shown now.
  visible: (doc: IndexDoc, s: RChatState) => boolean
  // Opens the place a document points to.
  open: (doc: IndexDoc) => void
  // Where a message document is, for its result row.
  place?: (doc: IndexDoc) => string
}

const sources = new Map<string, IndexSource>()

export const registerIndexSource = (source: IndexSource) => {
  sources.set(source.id, source)
  return () => void sources.delete(source.id)
}

export const indexSource = (id: string) => sources.get(id)

// Lets other sources add and drop their documents.
export const indexDocs = (docs: IndexDoc[]) => {
  if (index && docs.length) {
    index.add(docs)
    changed()
  }
}

export const dropIndexBucket = (bucket: string) => {
  if (!index) return
  index.dropBucket(bucket)
  changed()
}

export const dropIndexWhere = (pred: (d: IndexDoc) => boolean) => {
  if (index?.dropWhere(pred)) changed()
}

export const dropIndexIn = (bucket: string, pred: (d: IndexDoc) => boolean) => {
  if (index?.dropIn(bucket, pred)) changed()
}

export type IndexState = 'idle' | 'loading' | 'backfilling' | 'error'

export interface IndexStatus {
  mode: IndexMode
  bytes: number
  docs: number
  messages: number
  state: IndexState
  // Backfill progress: conversations done of all.
  done: number
  total: number
  error: string | null
}

const IDLE: IndexStatus = {
  mode: 'off',
  bytes: 0,
  docs: 0,
  messages: 0,
  state: 'idle',
  done: 0,
  total: 0,
  error: null,
}

export const useIndexStatus = create<IndexStatus>(() => IDLE)

let index: PaletteIndex | null = null
let owner: string | null = null
// Who the index belongs to, with the instance (`home.scoped`), and where its device copy lives;
// both are taken when the owner is set, so a later instance switch can't move them.
let ownerId: string | null = null
let ownerPrefix: string | null = null
let mode: IndexMode = 'off'
let gen = 0
// Bumped when the device copy is removed (Off, Loaded only, Clear index, logout, account switch).
// A save started before that writes nothing more, inside each IndexedDB transaction too.
let epoch = 0
// The save in progress, and device removals waiting for it.
let saving: Promise<void> = Promise.resolve()
let wiping: Promise<void> = Promise.resolve()
// The message arrays and member lists already indexed, by key.
let seenMessages = new Map<string, Message[]>()
let seenMembers = new Map<string, unknown>()
// Channel ids of servers that are not loaded in the store, checked with the server.
const verified = new Map<string, Set<number>>()
let saveTimer: ReturnType<typeof setTimeout> | null = null

export const paletteIndex = () => index

// Guests have no account to keep an index for: memory only.
export const effectiveMode = (wanted: IndexMode, guest: boolean): IndexMode =>
  guest && wanted === 'full' ? 'loaded' : wanted

const idOf = (who: string | null) => (who === null ? null : home.scoped(who))

const prefix = (who: string) => `palette:${home.scoped(who)}:`

const report = (patch: Partial<IndexStatus> = {}) =>
  useIndexStatus.setState(s => ({
    ...s,
    mode,
    bytes: index?.bytes ?? 0,
    docs: index?.count ?? 0,
    messages: index?.messageCount ?? 0,
    ...patch,
  }))

const scheduleSave = () => {
  if (mode !== 'full' || !owner || saveTimer) return
  saveTimer = setTimeout(() => {
    saveTimer = null
    void flush()
  }, 1500)
}

const flush = () => {
  if (mode !== 'full' || !index || !ownerPrefix) return saving
  const ix = index
  const at = ownerPrefix
  const e = epoch
  const live = () => e === epoch
  saving = saving.then(async () => {
    if (!live()) return
    try {
      await ix.save(blobs(), at, live)
    } catch {
      if (live()) report({ error: "Couldn't save the index on this device." })
    }
  })
  return saving
}

// Removes a device copy once the save in progress has stopped; saves started earlier write
// nothing more.
const wipeDevice = (at: string) => {
  epoch += 1
  wiping = Promise.all([wiping, saving])
    .then(() => blobs().clear(at))
    .catch(() => {})
  return wiping
}

const changed = () => {
  report()
  scheduleSave()
}

// --- documents -------------------------------------------------------------------------------

const INDEXED_KINDS = new Set(['user', 'poll'])

// Channel id to server name, over loaded servers and checked ones.
export const channelServers = (s: RChatState) => {
  const out = new Map<number, string>()
  for (const [server, ids] of verified) for (const id of ids) out.set(id, server)
  for (const [server, d] of Object.entries(s.servers))
    for (const c of d.channels) out.set(c.id, server)
  return out
}

// `server` is the message's server (null in DMs); a channel message without one is not indexed.
export const messageDoc = (
  s: RChatState,
  key: string,
  m: Message,
  server: string | null
): IndexDoc | null => {
  if (!INDEXED_KINDS.has(m.kind) || m.id <= 0) return null
  // Spoiler text is never indexed, so a search can't confirm what a spoiler hides.
  const text = replaceSpoilers(m.content, () => '\u2588\u2588\u2588').trim()
  if (!text || Object.hasOwn(s.blocked, m.author.username)) return null
  if (m.dm_id === null && !server) return null
  return {
    id: messageDocId(m.id),
    kind: 'message',
    bucket: key,
    source: 'instance',
    server: m.dm_id === null ? server : null,
    channel: m.channel_id,
    dm: m.dm_id,
    thread: m.thread_root_id,
    msg: m.id,
    author: m.author.username,
    name: m.author.display_name,
    text,
    at: m.created_at,
  }
}

export const memberDoc = (server: string, u: UserRef): IndexDoc => ({
  id: memberDocId(server, u.username),
  kind: 'member',
  bucket: memberBucket(server),
  source: 'instance',
  server,
  channel: null,
  dm: null,
  thread: null,
  msg: null,
  author: u.username,
  name: u.display_name,
  text: '',
  at: 0,
})

const channelIds = (s: RChatState, server: string): Set<number> | null => {
  const d = s.servers[server]
  return d ? new Set(d.channels.map(c => c.id)) : (verified.get(server) ?? null)
}

const dmBlocked = (s: RChatState, dmId: number) => {
  const dm = s.dms.find(d => d.id === dmId)
  return dm !== undefined && Object.hasOwn(s.blocked, dm.other.username)
}

// Whether a document may be shown now: its server is known and still has its channel, or it is
// a DM with someone not blocked.
export const docVisible = (s: RChatState, d: IndexDoc): boolean => {
  if (d.source !== 'instance') return sources.get(d.source)?.visible(d, s) ?? false
  if (Object.hasOwn(s.blocked, d.author)) return false
  if (d.kind === 'member') return d.server !== null && channelIds(s, d.server) !== null
  if (d.dm !== null) return !dmBlocked(s, d.dm)
  if (d.server === null || d.channel === null) return false
  return channelIds(s, d.server)?.has(d.channel) ?? false
}

// --- following the store ---------------------------------------------------------------------

// Documents for messages the viewer can see: DMs, and channels still listed for them.
const docsFor = (s: RChatState, key: string, list: readonly Message[], map: Map<number, string>) =>
  list.flatMap(m => {
    const server = m.channel_id === null ? null : (map.get(m.channel_id) ?? null)
    if (m.dm_id === null && server === null) return []
    return messageDoc(s, key, m, server) ?? []
  })

const msgIds = (list: readonly Message[]) => list.flatMap(m => (m.id > 0 ? [m.id] : []))

// A loaded list is a run of consecutive messages: within its id range, what it no longer has
// (deleted while away, edited to nothing) goes too.
const indexMessages = (s: RChatState) => {
  if (!index) return 0
  let n = 0
  let map: Map<number, string> | null = null
  for (const [key, list] of Object.entries(s.messages)) {
    if (seenMessages.get(key) === list) continue
    seenMessages.set(key, list)
    map ??= channelServers(s)
    n += index.reconcile(key, docsFor(s, key, list, map), msgIds(list))
  }
  return n
}

const indexMembers = (s: RChatState) => {
  if (!index) return 0
  let n = 0
  const servers = new Set([...Object.keys(s.members), ...Object.keys(s.memberInfo)])
  for (const server of servers) {
    const list = s.members[server]?.list
    const info = s.memberInfo[server]
    const key = `${server}`
    const mark = [list, info]
    const seen = seenMembers.get(key) as unknown[] | undefined
    if (seen && seen[0] === list && seen[1] === info) continue
    seenMembers.set(key, mark)
    if (channelIds(s, server) === null) continue
    const users: UserRef[] = [
      ...(list ?? []),
      ...Object.values(info ?? {}).filter((m): m is Member => m !== null),
    ]
    n += index.add(users.map(u => memberDoc(server, u)))
  }
  return n
}

const dropServer = (server: string) => {
  verified.delete(server)
  return index?.dropWhere(d => d.server === server) ?? 0
}

const dropChannel = (server: string | null, id: number) =>
  index?.dropWhere(d => d.channel === id && (server === null || d.server === server)) ?? 0

const forgetSeen = (pred: (key: string) => boolean) => {
  for (const key of [...seenMessages.keys()]) if (pred(key)) seenMessages.delete(key)
}

const memberServers = (s: RChatState) =>
  new Set([...(s.me?.servers.map(x => x.name) ?? []), ...s.guestServers])

const onState = (s: RChatState, prev: RChatState) => {
  const who = s.me?.username ?? (s.guest ? 'guest' : null)
  if (idOf(who) !== ownerId) {
    switchOwner(who, s.guest)
    return
  }
  if (!index) return
  let n = 0
  // Servers left, kicked or banned from, or deleted.
  if (prev.me && s.me && prev.me.servers !== s.me.servers && !s.me.servers_more) {
    const now = memberServers(s)
    for (const x of prev.me.servers) if (!now.has(x.name)) n += dropServer(x.name)
  }
  // Channels hidden or deleted.
  if (prev.servers !== s.servers)
    for (const [name, d] of Object.entries(prev.servers)) {
      const next = s.servers[name]
      if (!next) {
        if (!memberServers(s).has(name)) n += dropServer(name)
        continue
      }
      if (next.channels === d.channels) continue
      const ids = new Set(next.channels.map(c => c.id))
      for (const c of d.channels)
        if (!ids.has(c.id)) {
          n += dropChannel(name, c.id)
          forgetSeen(k => k === `c${c.id}`)
        }
    }
  // Newly blocked people: their messages and the DM with them.
  if (prev.blocked !== s.blocked)
    for (const u of Object.keys(s.blocked))
      if (!Object.hasOwn(prev.blocked, u)) {
        const dmIds = new Set(s.dms.filter(d => d.other.username === u).map(d => d.id))
        n += index.dropWhere(d => d.author === u || (d.dm !== null && dmIds.has(d.dm)))
      }
  if (prev.blocked !== s.blocked)
    for (const u of Object.keys(prev.blocked))
      if (!Object.hasOwn(s.blocked, u)) seenMessages = new Map()
  n += indexMessages(s)
  if (prev.members !== s.members || prev.memberInfo !== s.memberInfo) n += indexMembers(s)
  if (n) changed()
}

const onEvent = (ev: WsEvent) => {
  if (!index) return
  const me = useStore.getState().me?.username
  let n = 0
  switch (ev.type) {
    case 'message_updated': {
      // The new text replaces the old one, also for conversations that are not loaded. A stub
      // carries no text: the old one goes, and the loaded list adds the new one when it reloads.
      if (ev.stub) {
        index.remove([messageDocId(ev.id)])
        n = 1
        break
      }
      const before = index.get(messageDocId(ev.message.id))
      if (!before) return
      const s = useStore.getState()
      const server =
        ev.message.channel_id === null
          ? null
          : (channelServers(s).get(ev.message.channel_id) ?? before.server)
      const next = messageDoc(s, before.bucket, ev.message, server)
      if (next) index.add([next])
      else index.remove([before.id])
      n = 1
      break
    }
    case 'message_deleted':
      index.remove([messageDocId(ev.id)])
      index.dropBucket(`t${ev.id}`)
      n = 1
      break
    case 'messages_deleted':
      index.remove(ev.ids.map(messageDocId))
      for (const id of ev.ids) index.dropBucket(`t${id}`)
      n = 1
      break
    case 'channel_deleted':
      n = dropChannel(ev.server, ev.channel_id) + 1
      break
    case 'channel_perms_changed':
      // What may be read there can shrink (history included): start the channel over.
      n = dropChannel(ev.server, ev.channel_id) + 1
      forgetSeen(k => k === `c${ev.channel_id}` || k.startsWith('t'))
      if (!useStore.getState().servers[ev.server] && verified.has(ev.server))
        void verifyServer(ev.server, gen)
      break
    case 'server_deleted':
      n = dropServer(ev.name) + 1
      break
    case 'roles_changed':
    case 'admin_changed':
      // Roles can hide channels: servers that are only checked, not loaded, are checked again.
      if (ev.type === 'admin_changed' && ev.username !== me) return
      if (!useStore.getState().servers[ev.server] && verified.has(ev.server))
        void verifyServer(ev.server, gen)
      return
    case 'member_left':
    case 'member_kicked':
    case 'server_banned':
      if (ev.username === me) n = dropServer(ev.server) + 1
      break
    default:
      return
  }
  if (n) changed()
}

// --- lifecycle -------------------------------------------------------------------------------

const verifyServer = async (server: string, g: number) => {
  try {
    const d = await api.getServer(server)
    if (g !== gen || !index) return
    const ids = new Set(d.channels.map(c => c.id))
    verified.set(server, ids)
    index.dropWhere(x => x.server === server && x.channel !== null && !ids.has(x.channel))
  } catch (e) {
    if (g !== gen || !index) return
    if (e instanceof ApiError && (e.status === 404 || e.status === 403)) dropServer(server)
  }
  changed()
}

// Checks every server the stored index names: gone ones are dropped, the rest remember which
// channels can still be seen.
const reconcile = async (g: number) => {
  if (!index) return
  const s = useStore.getState()
  for (const [name, d] of Object.entries(s.servers)) {
    const ids = new Set(d.channels.map(c => c.id))
    index.dropWhere(x => x.server === name && x.channel !== null && !ids.has(x.channel))
  }
  for (const server of index.servers()) {
    if (g !== gen) return
    if (useStore.getState().servers[server]) continue
    await verifyServer(server, g)
  }
}

const REFILL_MS = 12 * 3_600_000
const BACKFILL_GAP_MS = 400

const wait = (ms: number) => new Promise(r => setTimeout(r, ms))

// Recent history of every text channel and DM, newest page only, while there is room.
const backfill = async (g: number) => {
  const live = () => g === gen && mode === 'full' && index !== null
  const s = useStore.getState()
  if (!s.me || s.guest) return
  const servers = s.me.servers.map(x => x.name)
  const jobs: { bucket: string; load: () => Promise<Message[]> }[] = []
  for (const server of servers) {
    let channels = s.servers[server]?.channels
    if (!channels) {
      try {
        channels = (await api.getServer(server)).channels
        verified.set(server, new Set(channels.map(c => c.id)))
      } catch {
        continue
      }
      await wait(BACKFILL_GAP_MS)
    }
    if (!live()) return
    for (const c of channels)
      if (c.kind === 'text')
        jobs.push({ bucket: `c${c.id}`, load: () => api.channelMessages(c.id) })
  }
  for (const dm of s.dms)
    if (!dm.closed && !Object.hasOwn(s.blocked, dm.other.username))
      jobs.push({ bucket: `d${dm.id}`, load: () => api.dmMessages(dm.id) })
  const now = Date.now()
  const todo = jobs.filter(j => !index || now - (index.filled[j.bucket] ?? 0) > REFILL_MS)
  report({ state: 'backfilling', done: 0, total: todo.length })
  let done = 0
  for (const job of todo) {
    if (!live() || !index) return
    if (index.bytes >= index.maxBytes * 0.9) break
    try {
      const list = await job.load()
      if (!live() || !index) return
      const st = useStore.getState()
      // The newest page replaces what was kept: messages deleted, hidden or edited since are
      // dropped, and older ones (which can't be checked without fetching everything) go too.
      const map = channelServers(st)
      index.reconcile(job.bucket, docsFor(st, job.bucket, list, map), msgIds(list), true)
      // What is loaded right now (older history scrolled to, for one) stays.
      const loaded = st.messages[job.bucket]
      if (loaded) index.add(docsFor(st, job.bucket, loaded, map))
      index.filled[job.bucket] = Date.now()
    } catch {
      // Gone or not readable: nothing to index.
    }
    done += 1
    report({ state: 'backfilling', done, total: todo.length })
    scheduleSave()
    await wait(BACKFILL_GAP_MS)
  }
  if (live()) {
    report({ state: 'idle' })
    scheduleSave()
  }
}

const start = async (g: number) => {
  if (!index || !owner || !ownerPrefix) return
  if (mode === 'full') {
    report({ state: 'loading', error: null })
    try {
      await index.load(blobs(), ownerPrefix)
    } catch {
      if (g === gen) report({ error: "Couldn't read the saved index." })
    }
    if (g !== gen) return
    await reconcile(g)
  }
  if (g !== gen) return
  const s = useStore.getState()
  indexMessages(s)
  indexMembers(s)
  report({ state: 'idle' })
  if (mode === 'full') {
    scheduleSave()
    void backfill(g)
  }
}

const reset = () => {
  gen += 1
  if (saveTimer) clearTimeout(saveTimer)
  saveTimer = null
  index = null
  seenMessages = new Map()
  seenMembers = new Map()
  verified.clear()
}

// A new account (or none, after logout): the previous account's device copy is removed, never
// saved again. Runs at once, so changes that follow each other can't interleave.
const switchOwner = (who: string | null, guest: boolean) => {
  const before = ownerPrefix
  const hadAccount = owner !== null && owner !== 'guest'
  reset()
  if (before && hadAccount) void wipeDevice(before)
  owner = who
  ownerId = idOf(who)
  ownerPrefix = who === null || guest ? null : prefix(who)
  mode = 'off'
  loadPalettePrefs(who)
  applyMode(effectiveMode(usePaletteUi.getState().prefs.index, guest))
}

// Turns the index on, off, or between memory and this device.
export const applyMode = (next: IndexMode) => {
  const before = mode
  mode = next
  if (!owner || next === 'off') {
    reset()
    mode = next
    if (ownerPrefix && before === 'full') void wipeDevice(ownerPrefix)
    useIndexStatus.setState({ ...IDLE, mode: next })
    return
  }
  if (index && before === next) return
  if (index && before !== 'off') {
    // Memory and device switch: keep what is indexed.
    index.maxBytes = next === 'full' ? FULL_MAX_BYTES : LOADED_MAX_BYTES
    index.trim()
    if (next === 'loaded' && ownerPrefix) void wipeDevice(ownerPrefix)
    const g = ++gen
    if (next === 'full') {
      index.touchAll()
      void (async () => {
        await flush()
        if (g === gen) void backfill(g)
      })()
    }
    report({ state: 'idle' })
    return
  }
  reset()
  mode = next
  index = new PaletteIndex(next === 'full' ? FULL_MAX_BYTES : LOADED_MAX_BYTES)
  report({ state: 'idle', error: null })
  void start(gen)
}

// Empties the index (and what this device kept). Loaded conversations are not indexed again
// until they change; Full mode backfills again next session.
export const clearIndex = async () => {
  if (index) {
    gen += 1
    index.clear()
    for (const [key, list] of Object.entries(useStore.getState().messages))
      seenMessages.set(key, list)
  }
  if (ownerPrefix) await wipeDevice(ownerPrefix)
  report({ state: 'idle', done: 0, total: 0, error: null })
}

// Starts following the store and live events; returns the cleanup.
export const startIndexSync = () => {
  const unsub = useStore.subscribe(onState)
  const untap = tapWs(onEvent)
  const s = useStore.getState()
  switchOwner(s.me?.username ?? (s.guest ? 'guest' : null), s.guest)
  const onHide = () => {
    if (document.visibilityState === 'hidden') void flush()
  }
  document.addEventListener('visibilitychange', onHide)
  return () => {
    unsub()
    untap()
    document.removeEventListener('visibilitychange', onHide)
    // Closing the app (not a logout): what is indexed stays on this device.
    void flush()
    reset()
    owner = null
    ownerId = null
    ownerPrefix = null
    mode = 'off'
  }
}

export const setIndexModeNow = (next: IndexMode) => {
  const s = useStore.getState()
  applyMode(effectiveMode(next, s.guest))
}

// For tests: the internals that follow the store.
export const __sync = {
  onState,
  onEvent,
  switchOwner,
  reconcile: () => reconcile(gen),
  settled: async () => {
    await saving
    await wiping
  },
}

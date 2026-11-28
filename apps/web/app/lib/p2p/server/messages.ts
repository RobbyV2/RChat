import {
  contentLack,
  holdsIn,
  knownRules,
  mayDelete,
  mayMentionEveryone,
  mayPin,
  richMessage,
  RULES_NEXT,
  rulesOf,
  textOnlyChannel,
} from '../acl/rules'
import { getEvents } from '../dag'
import { deadCounts, liveThreadPings } from '../thread_pings'
import { serverWire, type ChanCounts, type EventRecord } from '../db'
import {
  fitContent,
  fitForward,
  LIMITS as EV,
  type Attachment,
  type Fwd,
  type MsgContent,
} from '../content'
import { TOO_BIG_TEXT } from '../flows'
import { chanFactsOf, isOwner, membersOf, outranks } from '../state'
import { DmError, mentionsIn } from '../dm'
import { cleanName } from '../keys'
import { shownRoomProfile } from '../../profile_reset'
import type { ServerCtx } from './context'
import {
  ServerError,
  SlowModeError,
  THREAD_ROOT_TEXT,
  PIN_TEXT,
  PIN_THREAD_TEXT,
  MENTION_EVERYONE,
  lessPings,
} from './types'

export const NO_SEND_TEXT = "You can't send messages in this channel"
export const NO_FILES_TEXT = "You can't attach files in this channel"
export const NO_REACT_TEXT = "You can't react in this channel"
export const NO_THREAD_TEXT = "You can't start threads in this channel"
const LACK_TEXT = {
  send: NO_SEND_TEXT,
  react: NO_REACT_TEXT,
  pin: PIN_TEXT,
  attach: NO_FILES_TEXT,
}

// From rules 5, content the channel would not admit from us is refused before it is signed. A
// room of rules this version does not know is read-only, which signing says.
function requireHeld(
  cx: ServerCtx,
  room: string,
  ch: string,
  t: string,
  c: Record<string, unknown>
) {
  const F = chanFactsOf(cx.sumOf(room))
  if (!knownRules(F.rules) || rulesOf(F.rules) < RULES_NEXT) return
  const lack = contentLack(F, cx.me, ch, t, c)
  if (lack !== null) throw new ServerError(LACK_TEXT[lack])
}

// Whether the thread of `root` has a reply held here.
async function threadStarted(cx: ServerCtx, room: string, root: string) {
  const range = IDBKeyRange.bound([room, root, ''], [room, root, '\uffff'])
  let cursor = await cx.db.transaction('events').store.index('room_thread_sort').openCursor(range)
  while (cursor) {
    if (cursor.value.type === 'msg') return true
    cursor = await cursor.continue()
  }
  return false
}

// Member names a message may mention, by member.
export function mentionables(cx: ServerCtx, room: string) {
  const out: { ik: string; names: string[] }[] = []
  const s = cx.sumOf(room)
  for (const m of membersOf(s)) {
    if (m.m !== 'join' || m.ik === cx.me) continue
    const c = cx.deps.node.contact(m.ik)
    const names = [
      c?.petname,
      c?.name,
      shownRoomProfile(m, s.profiles, cx.clock.now(), cleanName).look?.name,
      cx.idents.get(m.ik)?.profile?.name,
      typeof m.profile?.name === 'string' ? m.profile.name : undefined,
    ]
    out.push({ ik: m.ik, names: [...new Set(names.filter((n): n is string => !!n))] })
  }
  return out
}

// A message inside our slow-mode interval would be hidden: it isn't signed.
export function content(cx: ServerCtx, room: string, t: string, c: Record<string, unknown>) {
  const ch = c.ch
  if (t !== 'msg' || typeof ch !== 'string') return cx.emit(room, t, () => c, { L: 'c' })
  return cx.locked(room, async () => {
    const sum = cx.sumOf(room)
    if (textOnlyChannel(sum.rules, sum.channels[ch]) && richMessage(c))
      throw new ServerError('This channel only accepts text.')
    const wait = await cx.slowLeft(room, ch)
    if (wait > 0) throw new SlowModeError(wait)
    return cx.emitNow(room, t, () => c, { L: 'c' })
  })
}

export async function send(
  cx: ServerCtx,
  room: string,
  msg: {
    ch: string
    body: string
    reply?: string
    fwd?: Fwd
    att?: Attachment[]
    thread?: string
  }
) {
  const content: MsgContent = { body: msg.body, ch: msg.ch }
  const F = chanFactsOf(cx.sumOf(room))
  if (msg.thread) {
    await cx.threadRoot(room, msg.thread, msg.ch)
    // From rules 5 the first reply of a thread needs Start threads.
    if (
      rulesOf(F.rules) >= RULES_NEXT &&
      !holdsIn(F, cx.me, msg.ch, 'StartThreads') &&
      !(await threadStarted(cx, room, msg.thread))
    )
      throw new ServerError(NO_THREAD_TEXT)
    content.thread = msg.thread
  }
  if (msg.reply) content.reply = msg.reply
  if (msg.att?.length) content.att = msg.att
  if (msg.fwd) content.fwd = msg.fwd
  else {
    const mentions = cx
      .mentionables(room)
      .filter(m => mentionsIn(msg.body, m.names))
      .map(m => m.ik)
      .slice(0, EV.mentions)
    if (mentions.length) content.mentions = mentions
    if (MENTION_EVERYONE.test(msg.body) && mayMentionEveryone(F, cx.me, msg.ch))
      content.everyone = true
  }
  requireHeld(cx, room, msg.ch, 'msg', content as unknown as Record<string, unknown>)
  const fitted = fitContent(fitForward(content))
  if (!fitted) throw new ServerError(TOO_BIG_TEXT)
  return cx.content(room, 'msg', fitted as unknown as Record<string, unknown>)
}

// A thread reply's root, when it is one: a top-level message of the same channel held here.
// A reply that names anything else (or a root not here yet) shows in its channel.
export async function rootOf(
  cx: ServerCtx,
  rec: EventRecord,
  get: (id: string) => Promise<EventRecord | undefined> = id => cx.db.get('events', id)
): Promise<string | null> {
  if (!rec.thread) return null
  const r = await get(rec.thread)
  return r && r.room === rec.room && r.type === 'msg' && r.chan === rec.chan && !r.thread
    ? rec.thread
    : null
}

// The thread an event of ours belongs to (null: none, or not a server event).
export async function threadOf(cx: ServerCtx, id: string) {
  const r = await cx.db.get('events', id)
  return r && cx.rooms.has(r.room) ? cx.rootOf(r) : null
}

// A thread's root: a top-level message of the channel that shows here.
export async function threadRoot(cx: ServerCtx, room: string, id: string, ch?: string) {
  const r = await cx.db.get('events', id)
  // A root whose body was evicted here for space still takes replies.
  const gone = (r?.purged || r?.redacted) && !r?.evicted
  if (!r || r.room !== room || r.type !== 'msg' || !r.chan || r.thread || gone)
    throw new ServerError(THREAD_ROOT_TEXT)
  if (ch !== undefined && r.chan !== ch) throw new ServerError(THREAD_ROOT_TEXT)
  const sh = (await cx.host.display(room, [id]))[0]
  if (!sh || sh.hidden) throw new ServerError(THREAD_ROOT_TEXT)
  return r
}

export async function message(cx: ServerCtx, room: string, target: string) {
  const r = await cx.db.get('events', target)
  if (!r || r.room !== room || r.type !== 'msg' || !r.chan)
    throw new ServerError('Message not found')
  return r
}

export async function edit(
  cx: ServerCtx,
  room: string,
  target: string,
  body: string,
  alts?: Record<string, string>
) {
  const r = await cx.message(room, target)
  if (r.sender !== cx.me || (serverWire(r).c as MsgContent | null)?.fwd)
    throw new ServerError("You can't edit this message")
  return cx.content(room, 'edit', { target, body, ch: r.chan, ...(alts ? { alts } : {}) })
}

export async function redact(cx: ServerCtx, room: string, target: string) {
  const r = await cx.db.get('events', target)
  if (!r || r.room !== room || r.layer !== 'c' || !r.chan)
    throw new ServerError("You can't delete this message")
  const s = cx.sumOf(room)
  if (
    r.sender !== cx.me &&
    !isOwner(s, cx.me) &&
    !(mayDelete(chanFactsOf(s), cx.me, r.chan) && outranks(s, cx.me, r.sender))
  )
    throw new ServerError("You can't delete this message")
  const id = await cx.content(room, 'redact', { target, ch: r.chan })
  cx.sync.redactWaiting(room, target)
  const o = await cx.db.get('outbox', target)
  if (o?.failed) await cx.db.delete('outbox', target)
  return id
}

export async function react(cx: ServerCtx, room: string, target: string, key: string, on: boolean) {
  const r = await cx.message(room, target)
  const c = { target, key, on, ch: r.chan }
  if (r.chan) requireHeld(cx, room, r.chan, 'react', c)
  return cx.content(room, 'react', c)
}

// Manage messages up to rules 4 and Pin messages in the channel from rules 5 (owners have
// both), top-level messages only, at most `dm.pinsMax` per channel.
export async function pin(cx: ServerCtx, room: string, target: string, on: boolean) {
  const r = await cx.message(room, target)
  if (!mayPin(chanFactsOf(cx.sumOf(room)), cx.me, r.chan ?? '')) throw new ServerError(PIN_TEXT)
  if (r.chan) requireHeld(cx, room, r.chan, 'pin', { target, on, ch: r.chan })
  if (await cx.rootOf(r)) throw new ServerError(PIN_THREAD_TEXT)
  if (on && r.chan) {
    const pins = await cx.loadPins(room, r.chan)
    const max = cx.local.dm.pinsMax
    if (pins.length >= max) throw new ServerError(`You can pin up to ${max} messages`)
  }
  return cx.content(room, 'pin', { target, on, ch: r.chan })
}

export async function retry(cx: ServerCtx, room: string, id: string) {
  const r = await cx.db.get('events', id)
  const o = await cx.db.get('outbox', id)
  if (!r || !o || r.room !== room || r.sender !== cx.me) return
  const v = await cx.check(room, r.wire)
  if (!v.ok) throw new DmError("This message can't be sent. Delete it instead.")
  await cx.db.put('outbox', { ...o, failed: false })
  const w = serverWire(r)
  if (w.ev.L === 'c') await cx.fillViews(room, typeof w.c?.ch === 'string' ? w.c.ch : '')
  cx.sync.resend(room, id, r.wire)
  cx.changed(room)
}

// Reads the channel up to now; pings on thread replies stay until their thread is read.
// `drop`: thread pings to take off as well, per root.
export async function markRead(
  cx: ServerCtx,
  room: string,
  ch: string,
  drop: Readonly<Record<string, number>> = {}
) {
  await cx.updateRoom(room, cur => {
    const old = cur.chans?.[ch]
    const threads: Record<string, number> = {}
    for (const [t, n] of Object.entries(old?.threads ?? {}))
      if (n - (drop[t] ?? 0) > 0) threads[t] = n - (drop[t] ?? 0)
    const left = Object.values(threads).reduce((a, b) => a + b, 0)
    if (old && !old.unread && old.pings === left && old.readSeq === cur.lastSeq) return null
    const next: ChanCounts = { unread: 0, pings: left, readSeq: cur.lastSeq }
    if (left) next.threads = threads
    return { ...cur, chans: { ...cur.chans, [ch]: next } }
  })
  cx.changed(room)
}

// Reads a channel and takes off the thread pings that no longer count: their reply (or the
// reaction) doesn't show or left its thread, or the thread's root doesn't show; counted pings
// not among `pings` (the log's unread thread pings of the channel) go too. Returns the ids of
// `pings` that no longer count.
// `counts`: the thread counters as they were before `pings` was read (default: now).
export async function readChannel(
  cx: ServerCtx,
  room: string,
  ch: string,
  pings: readonly { id: string; thread: string }[],
  counts: Readonly<Record<string, number>> = cx.threadCounts(room, ch)
) {
  const live = await cx.livePings(room, pings)
  await cx.markRead(room, ch, deadCounts(counts, pings, live))
  return pings.filter(p => !live.has(p.id)).map(p => p.id)
}

export function threadCounts(cx: ServerCtx, room: string, ch: string): Record<string, number> {
  return { ...cx.rooms.get(room)?.chans?.[ch]?.threads }
}

export function livePings(
  cx: ServerCtx,
  room: string,
  pings: readonly { id: string; thread: string }[]
) {
  return liveThreadPings(pings, {
    events: ids => getEvents(cx.db, room, ids),
    rootOf: m => cx.rootOf(m),
    shows: async ids => {
      const shown = await cx.host.display(room, ids)
      return new Set(ids.filter((_x, i) => shown[i] && !shown[i]?.hidden))
    },
  })
}

// Reads a thread: its pings come off the channel's counter.
export async function markThread(cx: ServerCtx, room: string, ch: string, root: string) {
  await cx.updateRoom(room, cur => {
    const old = cur.chans?.[ch]
    const n = old?.threads?.[root]
    if (!old || !n) return null
    return { ...cur, chans: { ...cur.chans, [ch]: lessPings(old, n, root) } }
  })
  cx.changed(room)
}

// Pings marked read one by one (the inbox): off the channel's counter (and the thread's), the
// read position stays.
export async function unping(
  cx: ServerCtx,
  room: string,
  ch: string,
  n: number,
  thread: string | null = null
) {
  await cx.updateRoom(room, cur => {
    const old = cur.chans?.[ch]
    if (!old?.pings) return null
    return { ...cur, chans: { ...cur.chans, [ch]: lessPings(old, n, thread) } }
  })
  cx.changed(room)
}

// In a channel, or in one of its threads (`root`).
export function typing(cx: ServerCtx, room: string, ch: string, on: boolean, root?: string) {
  cx.gossip.typing(room, ch, on, root)
}

export function typingIn(cx: ServerCtx, room: string, ch: string, root: string | null = null) {
  return cx.gossip.typingIn(room, ch, root)
}

export function loadOlder(cx: ServerCtx, room: string) {
  cx.sync.loadOlder(room)
}

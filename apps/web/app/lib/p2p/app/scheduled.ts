import { type ScheduledItem, type ScheduledLabel, whenText } from '../../scheduled'
import type { Attachment } from '../content'
import type { P2pStore, ScheduledRecord } from '../db'
import { DeviceSchedule, parseDraftKey, ScheduleError } from '../scheduled'
import type { IdentityScope, P2pParts } from './scope'
import { time } from '../../platform/time'

// Own messages looked at to find one a closed tab may have sent.
const SENT_LOOK = 200

export const deviceKey = (id: string) => `d:${id}`
const idOf = (key: string) => (key.startsWith('d:') ? key.slice(2) : key)

export function createScheduledPart(parts: Pick<P2pParts, 'store' | 'dms'>, scope: IdentityScope) {
  const state = parts.store
  const { useP2p, put, p2pHost } = state
  let unwatch: (() => void) | null = null

  const label = (key: string): ScheduledLabel | null => {
    const t = parseDraftKey(key)
    if (!t) return null
    const st = useP2p.getState()
    if (t.ch) {
      const v = st.servers[t.room]
      if (!v) return null
      const channel = v.channels.find(c => c.id === t.ch)?.name ?? null
      return { server: v.name, channel, person: null, by: null, thread: t.thread !== null }
    }
    const room = st.rooms[t.room]
    if (!room) return null
    return {
      server: null,
      channel: null,
      person: parts.dms.contactName(room.peer),
      by: room.peer,
      thread: t.thread !== null,
    }
  }

  const itemOf = (r: ScheduledRecord): ScheduledItem => ({
    key: deviceKey(r.id),
    side: 'device',
    place: r.key,
    body: r.body,
    files: (r.att ?? []).map(a => a.name),
    poll: null,
    reply: r.reply ?? null,
    at: r.at,
    next: r.next,
    state: r.state,
    error: r.state === 'failed' ? (r.error ?? null) : null,
    deferred: r.state === 'waiting' && r.error !== undefined,
    label: label(r.key),
  })

  const publish = () => {
    if (!scope.current()) return
    const rows = state.scheduled?.list() ?? []
    useP2p.setState({
      scheduled: rows.map(itemOf),
      scheduledMissed: rows.filter(r => r.state === 'missed').map(r => deviceKey(r.id)),
    })
  }

  // Our own `msg` events in the draft key's place, newest first: one with `body` since `since`.
  const sentSince = async (s: P2pStore, me: string, key: string, body: string, since: number) => {
    const t = parseDraftKey(key)
    if (!t) return false
    const range = IDBKeyRange.bound([t.room, me, ''], [t.room, me, '￿'])
    let cursor = await s.db
      .transaction('events')
      .store.index('room_sender_sort')
      .openCursor(range, 'prev')
    for (let n = 0; cursor && n < SENT_LOOK; n += 1) {
      const r = cursor.value
      const c = r.wire.c as { body?: unknown } | null
      const place = (r.chan ?? null) === t.ch && (r.thread ?? null) === t.thread
      if (r.type === 'msg' && r.receivedAt >= since && place && c?.body === body) return true
      cursor = await cursor.continue()
    }
    return false
  }

  const onWake = () => state.scheduled?.poke()
  let unlisten: (() => void) | null = null
  const listen = (w: Window, d: Document) => {
    const onShown = () => {
      if (d.visibilityState === 'visible') onWake()
    }
    w.addEventListener('online', onWake)
    d.addEventListener('visibilitychange', onShown)
    unlisten = () => {
      w.removeEventListener('online', onWake)
      d.removeEventListener('visibilitychange', onShown)
    }
  }

  // At the end of a boot in the tab that runs the node.
  const startScheduled = async (s: P2pStore, me: string, alive: () => boolean) => {
    if (state.scheduled) return
    const sch = new DeviceSchedule({
      db: s.db,
      post: (key, body, reply, att) => parts.dms.p2pDm.post(key, body, { reply, att }),
      sentSince: (key, body, since) => sentSince(s, me, key, body, since),
      onChange: publish,
    })
    put.scheduled(sch)
    unwatch = useP2p.subscribe((now, was) => {
      if (now.servers !== was.servers || now.rooms !== was.rooms || now.contacts !== was.contacts)
        publish()
    })
    // Only where there is a page to hear coming back online or into view from.
    if (
      typeof window !== 'undefined' &&
      typeof window.addEventListener === 'function' &&
      typeof document !== 'undefined' &&
      typeof document.addEventListener === 'function'
    )
      listen(window, document)
    await sch.start()
    if (!alive() && state.scheduled === sch) await stopScheduled()
  }

  // Resolves once a send in flight settled.
  const stopScheduled = () => {
    const sch = state.scheduled
    put.scheduled(null)
    unwatch?.()
    unwatch = null
    unlisten?.()
    unlisten = null
    if (scope.current()) useP2p.setState({ scheduled: [], scheduledMissed: [] })
    return sch ? sch.stop() : Promise.resolve()
  }

  const NOT_HERE = 'Scheduled messages send from the tab that runs P2P'

  const attempt = async (fn: (sch: DeviceSchedule) => Promise<unknown>) => {
    const sch = state.scheduled
    if (!sch) return NOT_HERE
    try {
      await fn(sch)
      return null
    } catch (e) {
      return e instanceof ScheduleError || e instanceof Error ? e.message : String(e)
    }
  }

  const p2pScheduled = {
    // Schedules `body` for `at` (ms) at a draft key, with the files `att` this device keeps; the
    // draft (still `draft`, as typed) and the reply bar clear.
    async add(
      key: string,
      m: { body: string; reply?: string; at: number; draft?: string; att?: Attachment[] }
    ) {
      const { draft = m.body, ...row } = m
      const error = await attempt(sch => sch.add(key, row))
      if (error || !scope.current()) return error
      const st = useP2p.getState()
      if ((st.drafts[key] ?? '') === draft) parts.dms.p2pDm.setDraft(key, '')
      if (m.reply && st.replying?.room === key && st.replying.id === m.reply)
        parts.dms.p2pDm.cancelReply()
      p2pHost.toast(`Scheduled for ${whenText(m.at, time().now())}`)
      return null
    },
    edit: (key: string, body: string) => attempt(sch => sch.edit(idOf(key), body)),
    removeReply: (key: string) => attempt(sch => sch.removeReply(idOf(key))),
    reschedule: (key: string, at: number) => attempt(sch => sch.reschedule(idOf(key), at)),
    remove: (key: string) => attempt(sch => sch.remove(idOf(key))),
    async sendNow(key: string) {
      const sch = state.scheduled
      if (!sch) return NOT_HERE
      return sch.sendNow(idOf(key))
    },
    // Device rows are never paused: only this device schedules them.
    resume: async (): Promise<string | null> => 'Not available here',
    // Whether this tab sends this identity's scheduled messages.
    here: () => state.scheduled !== null,
  }

  return { p2pScheduled, startScheduled, stopScheduled }
}

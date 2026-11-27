// Scheduled P2P messages: kept in this device's `scheduled` store and sent by the tab that runs
// the account's node, while it runs. A message more than `MISSED_MS` late asks before it is
// sent, and one cut off by a closed tab is never sent again without asking.

import { isLate, scheduleProblem, SEND_FAILED, settleWait } from '../scheduled'
import { b64u, bytesOf, randomBytes } from './canonical'
import { isEventId } from './content'
import type { P2pDatabase, ScheduledRecord } from './db'
import { bodyTooLong, DmError, TOO_LONG_TEXT } from './dm'
import { ServerError, SlowModeError } from './server/types'
import { realClock, type Clock } from './session'

export const SCHEDULED_ID_LEN = 16

// How often due rows are looked at besides the timer, and the longest timer the browser keeps.
export const CHECK_MS = 60_000
const TIMER_MAX = 2 ** 31 - 1

export interface DraftTarget {
  room: string
  ch: string | null
  thread: string | null
}

const PART = /^[^/#\s]+$/

// A draft key: "{room}", "{room}#{root}", "{room}/{channel}" or "{room}/{channel}#{root}".
export const parseDraftKey = (key: string): DraftTarget | null => {
  const [place, thread, extra] = key.split('#')
  if (extra !== undefined || (thread !== undefined && !PART.test(thread))) return null
  const [room, ch, more] = place.split('/')
  if (more !== undefined || !PART.test(room) || (ch !== undefined && !PART.test(ch))) return null
  return { room, ch: ch ?? null, thread: thread ?? null }
}

const STATES: readonly ScheduledRecord['state'][] = ['waiting', 'sending', 'failed', 'missed']
const time = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x)
const text = (x: unknown): x is string => typeof x === 'string'

// A stored row, checked field by field; null for one that can't be trusted, which is never
// sent. Unknown fields are left out.
export const readScheduled = (x: unknown): ScheduledRecord | null => {
  if (typeof x !== 'object' || x === null) return null
  const r = x as Record<string, unknown>
  if (!text(r.id) || bytesOf(r.id, SCHEDULED_ID_LEN) === null) return null
  if (!text(r.key) || !parseDraftKey(r.key)) return null
  if (!text(r.body) || !r.body.trim() || bodyTooLong(r.body)) return null
  if (r.reply !== undefined && !isEventId(r.reply)) return null
  if (!time(r.at) || !time(r.next) || !time(r.created)) return null
  if (!STATES.includes(r.state as ScheduledRecord['state'])) return null
  if (r.claim !== undefined && !text(r.claim)) return null
  if (r.claimedAt !== undefined && !time(r.claimedAt)) return null
  if (r.error !== undefined && !text(r.error)) return null
  return {
    id: r.id,
    key: r.key,
    body: r.body,
    ...(r.reply !== undefined ? { reply: r.reply as string } : {}),
    at: r.at,
    next: r.next,
    created: r.created,
    state: r.state as ScheduledRecord['state'],
    ...(r.claim !== undefined ? { claim: r.claim } : {}),
    ...(r.claimedAt !== undefined ? { claimedAt: r.claimedAt } : {}),
    ...(r.error !== undefined ? { error: r.error } : {}),
  }
}

// Why a message can't be scheduled as given.
export class ScheduleError extends Error {}

export interface ScheduleDeps {
  db: P2pDatabase
  clock?: Clock
  // Sends `body` to the place of draft key `key` now: the event id, or throws why not.
  post: (key: string, body: string, reply?: string) => Promise<string>
  // Whether our own message `body` reached `key` at or after `since`: a send a closed tab cut off.
  sentSince: (key: string, body: string, since: number) => Promise<boolean>
  // The rows changed.
  onChange: () => void
}

const settled = (r: ScheduledRecord): ScheduledRecord => {
  const { claim: _claim, claimedAt: _at, ...rest } = r
  return rest
}

// The schedule of one identity on this device. Only the tab that runs the node starts one.
export class DeviceSchedule {
  private readonly clock: Clock
  private rows: ScheduledRecord[] = []
  private timer: unknown = null
  private every: unknown = null
  private queue: Promise<unknown> = Promise.resolve()
  private stopped = true

  constructor(private readonly deps: ScheduleDeps) {
    this.clock = deps.clock ?? realClock
  }

  // A cut-off send is found among our messages or asks again; then the due rows go.
  async start() {
    this.stopped = false
    await this.serial(async () => {
      await this.recover()
      await this.refresh()
    })
    this.tick()
    this.poke()
  }

  // No new sends; resolves once the one in flight settled.
  async stop() {
    this.stopped = true
    this.clock.clear(this.timer)
    this.clock.clear(this.every)
    this.timer = this.every = null
    await this.queue.catch(() => {})
  }

  list(): ScheduledRecord[] {
    return this.rows
  }

  // Looks at the due rows soon (a wake, the tab shown, back online).
  poke() {
    if (!this.stopped) void this.serial(() => this.check())
  }

  async add(key: string, m: { body: string; reply?: string; at: number }) {
    if (!parseDraftKey(key)) throw new ScheduleError('Not available here')
    const problem = scheduleProblem(m.at, this.clock.now())
    if (problem) throw new ScheduleError(problem)
    this.checkBody(m.body)
    const row: ScheduledRecord = {
      id: b64u(randomBytes(SCHEDULED_ID_LEN)),
      key,
      body: m.body,
      ...(m.reply && isEventId(m.reply) ? { reply: m.reply } : {}),
      at: m.at,
      next: m.at,
      created: this.clock.now(),
      state: 'waiting',
    }
    await this.serial(async () => {
      await this.deps.db.put('scheduled', row)
      await this.refresh()
    })
    return row
  }

  edit(id: string, body: string) {
    this.checkBody(body)
    return this.change(id, r => (r.state === 'sending' ? null : { ...r, body }))
  }

  removeReply(id: string) {
    return this.change(id, r => {
      if (r.state === 'sending') return null
      const { reply: _reply, ...rest } = r
      return rest
    })
  }

  // A failed or missed one waits again.
  reschedule(id: string, at: number) {
    const problem = scheduleProblem(at, this.clock.now())
    if (problem) throw new ScheduleError(problem)
    return this.change(id, r => {
      if (r.state === 'sending') return null
      const { error: _error, ...rest } = settled(r)
      return { ...rest, at, next: at, state: 'waiting' }
    })
  }

  remove(id: string) {
    return this.serial(async () => {
      const tx = this.deps.db.transaction('scheduled', 'readwrite')
      const r = readScheduled(await tx.store.get(id))
      if (r?.state !== 'sending') await tx.store.delete(id)
      await tx.done
      await this.refresh()
    })
  }

  // Sends it now (Send, Retry): null once sent, else why not. Refused, a waiting one stays as
  // it was and a failed or missed one takes the reason.
  sendNow(id: string): Promise<string | null> {
    return this.serial(() => this.sendRow(id, true))
  }

  private checkBody(body: string) {
    if (!body.trim()) throw new ScheduleError('Type a message first')
    if (bodyTooLong(body)) throw new ScheduleError(TOO_LONG_TEXT)
  }

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn)
    this.queue = run.catch(() => {})
    return run
  }

  private async change(id: string, fn: (r: ScheduledRecord) => ScheduledRecord | null) {
    return this.serial(async () => {
      const tx = this.deps.db.transaction('scheduled', 'readwrite')
      const r = readScheduled(await tx.store.get(id))
      const next = r ? fn(r) : null
      if (next) await tx.store.put(next)
      await tx.done
      await this.refresh()
      return next !== null
    })
  }

  private async refresh() {
    const all = await this.deps.db.getAll('scheduled')
    this.rows = all.map(readScheduled).filter((r): r is ScheduledRecord => r !== null)
    this.arm()
    this.deps.onChange()
  }

  private arm() {
    this.clock.clear(this.timer)
    this.timer = null
    if (this.stopped) return
    const next = Math.min(...this.rows.filter(r => r.state === 'waiting').map(r => r.next))
    if (!Number.isFinite(next)) return
    const wait = Math.min(Math.max(0, next - this.clock.now()), TIMER_MAX)
    this.timer = this.clock.set(() => this.poke(), wait)
  }

  private tick() {
    this.clock.clear(this.every)
    if (this.stopped) return
    this.every = this.clock.set(() => {
      this.poke()
      this.tick()
    }, CHECK_MS)
  }

  private async recover() {
    for (const raw of await this.deps.db.getAll('scheduled')) {
      const r = readScheduled(raw)
      if (r?.state !== 'sending') continue
      const sent = await this.deps
        .sentSince(r.key, r.body, r.claimedAt ?? r.created)
        .catch(() => false)
      if (sent) await this.deps.db.delete('scheduled', r.id)
      else await this.deps.db.put('scheduled', { ...settled(r), state: 'missed' })
    }
  }

  private async check() {
    if (this.stopped) return
    const now = this.clock.now()
    const due = await this.deps.db.getAllFromIndex('scheduled', 'next', IDBKeyRange.upperBound(now))
    let changed = false
    for (const raw of due) {
      if (this.stopped) break
      const r = readScheduled(raw)
      if (r?.state !== 'waiting') continue
      if (isLate(r.next, this.clock.now())) {
        await this.deps.db.put('scheduled', { ...settled(r), state: 'missed' })
        changed = true
        continue
      }
      await this.sendRow(r.id, false)
    }
    if (changed) await this.refresh()
    else this.arm()
  }

  // Claims row `id` in one transaction, sends it through the normal send path and settles it.
  private async sendRow(id: string, forced: boolean): Promise<string | null> {
    const claim = b64u(randomBytes(SCHEDULED_ID_LEN))
    const at = this.clock.now()
    const tx = this.deps.db.transaction('scheduled', 'readwrite')
    const r = readScheduled(await tx.store.get(id))
    const ok = r !== null && (r.state === 'waiting' || (forced && r.state !== 'sending'))
    if (ok) await tx.store.put({ ...r, state: 'sending', claim, claimedAt: at })
    await tx.done
    if (!r || !ok) return r?.state === 'sending' ? 'It is being sent' : null
    let error: string | null = null
    try {
      await this.deps.post(r.key, r.body, r.reply)
      await this.settle(id, claim, null)
    } catch (e) {
      error = e instanceof Error ? e.message : SEND_FAILED
      const now = this.clock.now()
      const back = forced && r.state === 'waiting'
      const next: ScheduledRecord = back ? settled(r) : this.refused(r, e, now)
      await this.settle(id, claim, next)
    }
    await this.refresh()
    return error
  }

  private refused(r: ScheduledRecord, e: unknown, now: number): ScheduledRecord {
    const base = settled(r)
    if (e instanceof SlowModeError) {
      const s = settleWait(r.at, now, e.waitMs)
      if (s.kind === 'defer') return { ...base, state: 'waiting', next: s.next, error: s.note }
      if (s.kind === 'fail') return { ...base, state: 'failed', error: s.error }
    }
    const error = e instanceof DmError || e instanceof ServerError ? e.message : SEND_FAILED
    return { ...base, state: 'failed', error }
  }

  // Deletes a sent row or writes `next`, while the claim is ours.
  private async settle(id: string, claim: string, next: ScheduledRecord | null) {
    const tx = this.deps.db.transaction('scheduled', 'readwrite')
    const r = readScheduled(await tx.store.get(id))
    if (r?.claim === claim) {
      if (next) await tx.store.put(next)
      else await tx.store.delete(id)
    }
    await tx.done
  }
}

import { afterEach, describe, expect, test } from 'bun:test'
import { ManualClock, settle } from './p2p_net'
import { b64u, randomBytes } from '../p2p/canonical'
import type { Attachment } from '../p2p/content'
import { P2pStore, type ScheduledRecord } from '../p2p/db'
import { DmError } from '../p2p/dm'
import { EMPTY_ROOT } from '../p2p/hashing'
import {
  CHECK_MS,
  DeviceSchedule,
  parseDraftKey,
  readScheduled,
  ScheduleError,
  type ScheduleDeps,
} from '../p2p/scheduled'
import { isSealedScheduled } from '../p2p/scheduled_rows'
import { dropSealed } from '../p2p/sealed_drop'
import { ServerError, SlowModeError } from '../p2p/server/types'
import { EXCLUDED } from '../p2p/transfer'
import { MISSED_MS, SLOW_FAILED, WAITING_SLOW } from '../scheduled'

const open: { store: P2pStore; sch: DeviceSchedule }[] = []
afterEach(async () => {
  for (const { store, sch } of open.splice(0)) {
    await sch.stop()
    store.close()
  }
})

const EVENT = b64u(randomBytes(32))
let n = 0

interface Rig {
  store: P2pStore
  sch: DeviceSchedule
  clock: ManualClock
  posts: { key: string; body: string; reply?: string; att?: Attachment[] }[]
  // What the next sends do, in order; a send past the list goes through.
  next: (() => Promise<string>)[]
  rows: () => Promise<ScheduledRecord[]>
}

const rig = async (over: Partial<ScheduleDeps> = {}, start = true): Promise<Rig> => {
  const store = await P2pStore.create(`scheduled-test-${n++}`)
  const clock = new ManualClock()
  const posts: Rig['posts'] = []
  const next: Rig['next'] = []
  const sch = new DeviceSchedule({
    db: store.db,
    clock,
    post: async (key, body, reply, att) => {
      posts.push({ key, body, ...(reply ? { reply } : {}), ...(att ? { att } : {}) })
      const step = next.shift()
      return step ? step() : 'event'
    },
    sentSince: async () => false,
    onChange: () => {},
    ...over,
  })
  open.push({ store, sch })
  if (start) await sch.start()
  return {
    store,
    sch,
    clock,
    posts,
    next,
    rows: async () => (await store.db.getAll('scheduled')).map(r => readScheduled(r)!),
  }
}

const MIN = 60_000

describe('device schedule', () => {
  test('a message goes out at its time through the send path, with its reply', async () => {
    const r = await rig()
    await r.sch.add('room/ch#root', { body: 'hello', reply: EVENT, at: r.clock.now() + 5 * MIN })
    expect(r.sch.list().map(x => x.state)).toEqual(['waiting'])
    await r.clock.advance(4 * MIN)
    expect(r.posts).toEqual([])
    await r.clock.advance(MIN)
    expect(r.posts).toEqual([{ key: 'room/ch#root', body: 'hello', reply: EVENT }])
    expect(await r.rows()).toEqual([])
    expect(r.sch.list()).toEqual([])
  })

  test('scheduling checks the time, the text and the place', async () => {
    const r = await rig()
    const now = r.clock.now()
    const refused = (p: Promise<unknown>) =>
      p.then(
        () => null,
        (e: unknown) => (e instanceof ScheduleError ? e.message : 'other')
      )
    expect(await refused(r.sch.add('room', { body: 'hi', at: now + 30_000 }))).toBe(
      'Pick a time at least 1 minute ahead'
    )
    expect(await refused(r.sch.add('room', { body: '  ', at: now + MIN }))).toBe(
      'Type a message first'
    )
    expect(await refused(r.sch.add('a/b/c', { body: 'hi', at: now + MIN }))).toBe(
      'Not available here'
    )
    await r.sch.add('room', { body: 'hi', reply: 'not an id', at: now + MIN })
    expect((await r.rows())[0].reply).toBeUndefined()
  })

  test('slow mode holds it within an hour of its time, then it fails', async () => {
    const r = await rig()
    r.next.push(() => Promise.reject(new SlowModeError(30_000)))
    await r.sch.add('room/ch', { body: 'slow', at: r.clock.now() + MIN })
    await r.clock.advance(MIN)
    const [held] = await r.rows()
    expect([held.state, held.error, held.next]).toEqual([
      'waiting',
      WAITING_SLOW,
      r.clock.now() + 30_000,
    ])
    await r.clock.advance(30_000)
    expect(r.posts.length).toBe(2)
    expect(await r.rows()).toEqual([])
    r.next.push(() => Promise.reject(new SlowModeError(2 * 3_600_000)))
    await r.sch.add('room/ch', { body: 'too slow', at: r.clock.now() + MIN })
    await r.clock.advance(MIN)
    const [failed] = await r.rows()
    expect([failed.state, failed.error]).toEqual(['failed', SLOW_FAILED])
  })

  test('a refusal fails it with its reason, anything else with the plain one', async () => {
    const r = await rig()
    r.next.push(
      () => Promise.reject(new ServerError("You can't send messages in this channel")),
      () => Promise.reject(new DmError('This user blocked you')),
      () => Promise.reject(new TypeError('boom'))
    )
    for (const body of ['a', 'b', 'c'])
      await r.sch.add('room/ch', { body, at: r.clock.now() + MIN })
    await r.clock.advance(MIN)
    const errors = (await r.rows()).map(x => [x.state, x.error]).sort()
    expect(errors).toEqual([
      ['failed', 'Something went wrong. Try again.'],
      ['failed', 'This user blocked you'],
      ['failed', "You can't send messages in this channel"],
    ])
  })

  test('more than two minutes late it waits for Send and is never sent before', async () => {
    const r = await rig()
    const row = await r.sch.add('room', { body: 'late', at: r.clock.now() + MIN })
    r.clock.t += MIN + MISSED_MS + 1
    r.sch.poke()
    await settle()
    expect(r.posts).toEqual([])
    expect((await r.rows())[0].state).toBe('missed')
    await r.clock.advance(10 * MIN)
    expect(r.posts).toEqual([])
    expect(await r.sch.sendNow(row.id)).toBeNull()
    expect(r.posts.map(p => p.body)).toEqual(['late'])
    expect(await r.rows()).toEqual([])
  })

  test('send now refused keeps a waiting one and gives a failed one the reason', async () => {
    const r = await rig()
    const row = await r.sch.add('room', { body: 'now', at: r.clock.now() + 10 * MIN })
    r.next.push(() => Promise.reject(new DmError('Blocked')))
    expect(await r.sch.sendNow(row.id)).toBe('Blocked')
    const [kept] = await r.rows()
    expect([kept.state, kept.error, kept.next, kept.claim]).toEqual([
      'waiting',
      undefined,
      row.next,
      undefined,
    ])
    await r.store.db.put('scheduled', { ...kept, state: 'failed', error: 'Old' })
    r.next.push(() => Promise.reject(new DmError('Still blocked')))
    expect(await r.sch.sendNow(row.id)).toBe('Still blocked')
    expect((await r.rows())[0].error).toBe('Still blocked')
    await r.sch.reschedule(row.id, r.clock.now() + 2 * MIN)
    const [again] = await r.rows()
    expect([again.state, again.error]).toEqual(['waiting', undefined])
  })

  test('a send a closed tab cut off is found, or asks', async () => {
    const r = await rig({}, false)
    const now = r.clock.now()
    const cut = (id: string, body: string): ScheduledRecord => ({
      id,
      key: 'room',
      body,
      at: now - MIN,
      next: now - MIN,
      created: now - 2 * MIN,
      state: 'sending',
      claim: 'c',
      claimedAt: now - MIN,
    })
    const found = b64u(randomBytes(16))
    const lost = b64u(randomBytes(16))
    await r.store.db.put('scheduled', cut(found, 'went out'))
    await r.store.db.put('scheduled', cut(lost, 'did not'))
    const asked: [string, number][] = []
    const sch = new DeviceSchedule({
      db: r.store.db,
      clock: r.clock,
      post: async () => 'event',
      sentSince: async (_key, body, since) => {
        asked.push([body, since])
        return body === 'went out'
      },
      onChange: () => {},
    })
    open.push({ store: r.store, sch })
    await sch.start()
    expect(asked.sort()).toEqual([
      ['did not', now - MIN],
      ['went out', now - MIN],
    ])
    const rows = await r.rows()
    expect(rows.map(x => [x.body, x.state, x.claim])).toEqual([['did not', 'missed', undefined]])
  })

  test('stopping waits for the send in flight', async () => {
    let release = () => {}
    const r = await rig({
      post: () => new Promise<string>(done => (release = () => done('event'))),
    })
    await r.sch.add('room', { body: 'slow send', at: r.clock.now() + MIN })
    await r.clock.advance(MIN)
    expect((await r.rows())[0].state).toBe('sending')
    let stopped = false
    const stopping = r.sch.stop().then(() => (stopped = true))
    await settle()
    expect(stopped).toBe(false)
    release()
    await stopping
    expect(stopped).toBe(true)
    expect(await r.rows()).toEqual([])
  })

  test('a schedule that was never started never sends', async () => {
    const leader = await rig()
    await leader.sch.add('room', { body: 'once', at: leader.clock.now() + MIN })
    await leader.sch.stop()
    const posts: string[] = []
    const follower = new DeviceSchedule({
      db: leader.store.db,
      clock: leader.clock,
      post: async (_k, body) => {
        posts.push(body)
        return 'event'
      },
      sentSince: async () => false,
      onChange: () => {},
    })
    open.push({ store: leader.store, sch: follower })
    follower.poke()
    await leader.clock.advance(2 * MIN)
    expect(posts).toEqual([])
    expect(leader.posts).toEqual([])
  })

  test('rows that fail the checks are skipped and never sent', async () => {
    const r = await rig()
    const now = r.clock.now()
    const good: ScheduledRecord = {
      id: b64u(randomBytes(16)),
      key: 'room/ch',
      body: 'fine',
      at: now - 1,
      next: now - 1,
      created: now - MIN,
      state: 'waiting',
    }
    for (const bad of [
      { ...good, id: 'short' },
      { ...good, id: b64u(randomBytes(16)), key: 'a/b/c' },
      { ...good, id: b64u(randomBytes(16)), body: '' },
      { ...good, id: b64u(randomBytes(16)), reply: 'nope' },
      { ...good, id: b64u(randomBytes(16)), at: Number.NaN },
      { ...good, id: b64u(randomBytes(16)), state: 'paused' },
    ]) {
      expect(readScheduled(bad)).toBeNull()
      await r.store.db.put('scheduled', bad as ScheduledRecord)
    }
    expect(readScheduled({ ...good, extra: 1 })).toEqual(good)
    expect(readScheduled(null)).toBeNull()
    r.sch.poke()
    await settle()
    expect(r.posts).toEqual([])
  })
})

const why = (p: Promise<unknown>) =>
  p.then(
    () => 'ok',
    (e: Error) => e.message
  )

describe('scheduled files', () => {
  const FILE: Attachment = {
    h: EMPTY_ROOT,
    size: 0,
    blocks: 0,
    name: 'notes.txt',
    mime: 'text/plain',
  }

  test('files go out with the message, also without text', async () => {
    const r = await rig()
    await r.sch.add('room', { body: '', at: r.clock.now() + 5 * MIN, att: [FILE] })
    expect(r.sch.list()[0].att).toEqual([FILE])
    expect(await why(r.sch.add('room', { body: ' ', at: r.clock.now() + 5 * MIN }))).toBe(
      'Type a message first'
    )
    await r.clock.advance(5 * MIN)
    expect(r.posts).toEqual([{ key: 'room', body: '', att: [FILE] }])
  })

  test('an edit may clear the text of one that has files, never of one without', async () => {
    const r = await rig()
    const at = r.clock.now() + 5 * MIN
    const withFile = await r.sch.add('room', { body: 'see this', at, att: [FILE] })
    const plain = await r.sch.add('room', { body: 'words', at })
    expect(await r.sch.edit(withFile.id, '')).toBe(true)
    expect(await why(r.sch.edit(plain.id, ' '))).toBe('Type a message first')
    expect(
      r.sch
        .list()
        .map(x => x.body)
        .sort()
    ).toEqual(['', 'words'])
  })

  test('stored rows with files that are not files are never sent', async () => {
    const r = await rig()
    const row = await r.sch.add('room', { body: 'x', at: r.clock.now() + 5 * MIN, att: [FILE] })
    expect(readScheduled({ ...row, att: [{ ...FILE, name: '' }] })).toBeNull()
    expect(readScheduled({ ...row, att: 'nope' })).toBeNull()
    expect(readScheduled({ ...row, body: '', att: [] })).toBeNull()
    expect(readScheduled({ ...row, body: '' })?.att).toEqual([FILE])
  })

  test('a sealed room keeps the file names in the device record', async () => {
    const r = await rig()
    await r.store.sealing.setRoom('room', true)
    await r.sch.add('room', { body: '', at: r.clock.now() + 5 * MIN, att: [FILE] })
    const stored = (await r.store.sealing.stored.getAll('scheduled')) as unknown[]
    expect(JSON.stringify(stored)).not.toContain('notes.txt')
    expect(stored.every(isSealedScheduled)).toBe(true)
    expect(r.sch.list()[0].att).toEqual([FILE])
  })
})

describe('scheduled messages of sealed rooms', () => {
  const dec = new TextDecoder()
  const raw = (r: Rig) => r.store.sealing.stored.getAll('scheduled') as Promise<unknown[]>
  const holds = (row: unknown, text: string) =>
    JSON.stringify(row).includes(text) ||
    Object.values(row as object).some(v => ArrayBuffer.isView(v) && dec.decode(v).includes(text))

  test('a sealed room keeps the text and the reply in a device record', async () => {
    const r = await rig()
    await r.store.sealing.setRoom('room', true)
    const at = r.clock.now() + 5 * MIN
    await r.sch.add('room/ch', { body: 'quiet words', reply: EVENT, at })
    await r.sch.add('other', { body: 'open words', at })
    const stored = await raw(r)
    const sealed = stored.filter(isSealedScheduled)
    expect(sealed).toHaveLength(1)
    expect(Object.keys(sealed[0]).sort()).toEqual([
      'at',
      'box',
      'created',
      'id',
      'key',
      'next',
      'state',
    ])
    expect(stored.some(row => holds(row, 'quiet words') || holds(row, EVENT))).toBe(false)
    expect(stored.some(row => holds(row, 'open words'))).toBe(true)
    expect(
      r.sch
        .list()
        .map(x => x.body)
        .sort()
    ).toEqual(['open words', 'quiet words'])

    const id = r.sch.list().find(x => x.body === 'quiet words')!.id
    await r.sch.edit(id, 'quieter words')
    expect((await raw(r)).some(row => holds(row, 'quieter words'))).toBe(false)
    await r.clock.advance(5 * MIN)
    expect(r.posts.filter(x => x.key === 'room/ch')).toEqual([
      { key: 'room/ch', body: 'quieter words', reply: EVENT },
    ])
    expect(await raw(r)).toEqual([])
  })

  test('one scheduled before the switch is sealed at the next look, and sends', async () => {
    const r = await rig()
    await r.sch.add('room', { body: 'early words', at: r.clock.now() + 5 * MIN })
    expect((await raw(r)).some(isSealedScheduled)).toBe(false)
    await r.store.sealing.setRoom('room', true)
    await r.clock.advance(CHECK_MS)
    const stored = await raw(r)
    expect(stored.every(isSealedScheduled)).toBe(true)
    expect(stored.some(row => holds(row, 'early words'))).toBe(false)
    await r.clock.advance(4 * MIN)
    expect(r.posts).toEqual([{ key: 'room', body: 'early words' }])
  })

  test('a record that does not open is never sent', async () => {
    const r = await rig()
    await r.store.sealing.setRoom('room', true)
    await r.sch.add('room', { body: 'quiet words', at: r.clock.now() + 5 * MIN })
    const [row] = (await raw(r)) as { id: string; box: Uint8Array }[]
    const box = row.box.slice()
    box[box.length - 1] ^= 1
    await r.store.sealing.stored.put('scheduled', { ...row, box })
    await r.clock.advance(6 * MIN)
    expect(r.posts).toEqual([])
    expect(r.sch.list()).toEqual([])
  })

  test('a device that lost its key drops the sealed ones and keeps the rest', async () => {
    const r = await rig()
    await r.store.sealing.setRoom('room', true)
    const at = r.clock.now() + 5 * MIN
    await r.sch.add('room', { body: 'quiet words', at })
    await r.sch.add('other', { body: 'open words', at })
    await dropSealed(r.store.db)
    const left = (await raw(r)).map(row => readScheduled(row)?.body)
    expect(left).toEqual(['open words'])
  })
})

describe('draft keys and device moves', () => {
  test('draft keys parse', () => {
    expect(parseDraftKey('room')).toEqual({ room: 'room', ch: null, thread: null })
    expect(parseDraftKey('room#root')).toEqual({ room: 'room', ch: null, thread: 'root' })
    expect(parseDraftKey('room/ch#root')).toEqual({ room: 'room', ch: 'ch', thread: 'root' })
    for (const bad of ['', '/ch', 'room/', 'room/ch/x', 'a#b#c', 'room#', 'ro om'])
      expect(parseDraftKey(bad)).toBeNull()
  })

  test('scheduled messages never leave the device in a move', () => {
    expect(EXCLUDED.has('scheduled')).toBe(true)
  })
})

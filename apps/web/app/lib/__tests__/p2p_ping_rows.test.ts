import { describe, expect, test } from 'bun:test'
import {
  addPings,
  isSealedPing,
  logValue,
  markSeen,
  parseLog,
  whatOf,
  type PingRec,
  type PingRow,
  type SealedPing,
} from '../p2p/inbox'
import type { P2pStore } from '../p2p/db'
import { openPings, PingLog, sealPings } from '../p2p/ping_log'

const ping: PingRec = {
  id: 'e1',
  room: 'r',
  ch: null,
  kind: 'reaction',
  actor: 'a',
  at: 10,
  seq: 3,
  emoji: '🦊',
  target: 'm1',
  seen: false,
  thread: null,
}

const sealed: SealedPing = {
  id: 'e2',
  room: 'r',
  ch: null,
  actor: 'a',
  at: 10,
  seq: 3,
  target: 'm1',
  seen: false,
  thread: null,
  box: new Uint8Array([0x52, 0x02, 1, 2, 3]),
}

describe('stored ping rows', () => {
  test('a sealed row keeps its box and its plain fields, and nothing of what pinged', () => {
    const [plain, boxed] = parseLog(logValue([ping, sealed]))
    expect(plain).toEqual(ping)
    expect(isSealedPing(boxed)).toBe(true)
    expect(boxed).toEqual(sealed)
    expect('kind' in boxed || 'emoji' in boxed).toBe(false)
    expect(isSealedPing(plain)).toBe(false)
  })

  test('a row is left out when its fields are not well formed, sealed or not', () => {
    const list = [
      { ...sealed, id: 'e3', box: 'not bytes' },
      { ...ping, id: 'e4', kind: 'shout' },
      { ...sealed, id: 'e5', at: -1 },
      { ...ping, id: 'e6', emoji: 'x'.repeat(65) },
    ]
    expect(parseLog({ v: 1, list }).map(p => [p.id, 'emoji' in p ? p.emoji : 'box'])).toEqual([
      ['e6', null],
    ])
  })

  test('what a box holds reads only as a known kind and a short emoji', () => {
    expect(whatOf({ kind: 'mention', emoji: null })).toEqual({ kind: 'mention', emoji: null })
    expect(whatOf({ kind: 'reaction', emoji: '🦊', extra: 1 })).toEqual({
      kind: 'reaction',
      emoji: '🦊',
    })
    expect(whatOf({ kind: 'reaction' })).toEqual({ kind: 'reaction', emoji: null })
    expect(whatOf({ kind: 'other', emoji: null })).toBeNull()
    expect(whatOf('mention')).toBeNull()
    expect(whatOf(undefined)).toBeNull()
  })

  test('pruning and marking keep a sealed row sealed', () => {
    const kept = addPings<PingRow>([sealed], [ping], 20)
    expect(kept.map(p => p.id)).toEqual(['e2', 'e1'])
    const marked = markSeen(kept, new Set(['e2']))
    const row = marked.find(p => p.id === 'e2')!
    expect(row).toEqual({ ...sealed, seen: true })
  })

  test('without a sealing nothing is boxed, and a box that cannot be opened is not shown', async () => {
    expect(await sealPings(undefined, [ping])).toEqual([ping])
    expect(await openPings(undefined, [ping, sealed])).toEqual([ping])
  })

  test('thread lookups read the plain fields of sealed rows without opening them', async () => {
    const inThread: SealedPing = { ...sealed, id: 'e7', ch: 'c', seq: 9, thread: 't' }
    const store = {
      closed: false,
      sealing: undefined,
      meta: async () => logValue([inThread]),
      rooms: async () => [],
    } as unknown as P2pStore
    const log = new PingLog({
      store,
      dms: { unping: async () => {} },
      servers: { unping: async () => {} },
    })
    expect(await log.threadPings('r', 'c')).toEqual([{ id: 'e7', thread: 't' }])
    expect(await log.ofThread('r', 'c', 't')).toEqual(['e7'])
    expect((await log.read()).list).toEqual([])
  })
})

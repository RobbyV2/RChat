import 'fake-indexeddb/auto'
import { afterEach, describe, expect, test } from 'bun:test'
import { Hub, ManualClock } from './p2p_net'
import type { PartRecord } from '../p2p/db'
import { partRange } from '../p2p/blobs'
import { dropSealed } from '../p2p/sealed_drop'
import { DEVICE_KEYS_META } from '../platform/device_keys'
import {
  bodies,
  general,
  joinWithCode,
  makeMember,
  pump,
  stopAll,
  stopMember,
  type Member,
} from './p2p_server_net'

afterEach(stopAll)

const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]

const fileOf = async (seed: number, size: number, name: string) => {
  const { hashBytes } = await import('../p2p/hashing')
  const data = new Uint8Array(size).map((_, i) => (i < PNG.length ? PNG[i] : (i * 7 + seed) % 251))
  const h = await hashBytes(data)
  return {
    data,
    hashed: h,
    att: { h: h.h, size: h.size, blocks: h.blocks.length, name, mime: 'image/png' },
  }
}

// The blocks of file `h` as `m`'s device stores them.
const parts = async (m: Member, h: string) =>
  (await m.store.sealing.stored.getAll('blob_parts', partRange(h))) as PartRecord[]

const opened = async (m: Member, h: string) => {
  const blob = await m.dms.blobs.file(h)
  return blob ? new Uint8Array(await blob.arrayBuffer()) : null
}

const head = async (p: PartRecord) => [...new Uint8Array(await p.data.slice(0, 2).arrayBuffer())]

describe('files of an encrypted P2P server', () => {
  test('are stored as sealed blocks on every device, served and opened', async () => {
    const clock = new ManualClock()
    const hub = new Hub()
    const a = await makeMember(hub, 'Alice', clock)
    const b = await makeMember(hub, 'Bob', clock)
    const room = await a.servers.create('Vault')
    const ch = general(a, room)
    await joinWithCode(clock, a, room, b)
    await a.servers.setStore(room, true)
    await pump(clock, () => b.store.sealing.room(room), 'bob follows the switch')

    // A file kept for a plain place stays plain while another room seals.
    const other = await a.servers.create('Open')
    const p = await fileOf(7, 2000, 'open.png')
    await a.dms.blobs.putOwn(new Blob([p.data as BlobPart]), p.hashed, other)
    expect((await a.dms.blobs.record(p.att.h))?.file instanceof Blob).toBe(true)
    // Sent into the sealed room, the same file is stored sealed from then on.
    await a.dms.blobs.putOwn(new Blob([p.data as BlobPart]), p.hashed, room)
    expect((await a.dms.blobs.record(p.att.h))?.file).toBeUndefined()
    expect((await parts(a, p.att.h)).map(x => x.sealed)).toEqual([true])
    expect(await opened(a, p.att.h)).toEqual(p.data)

    const f = await fileOf(3, 2 * 1024 * 1024 + 5, 'notes.bin')
    await a.dms.blobs.putOwn(new Blob([f.data as BlobPart]), f.hashed, room)
    const own = await a.dms.blobs.record(f.att.h)
    expect(own?.done).toBe(true)
    expect(own?.file).toBeUndefined()
    const mine = await parts(a, f.att.h)
    expect(mine.map(p => [p.block, p.sealed])).toEqual([
      [0, true],
      [1, true],
      [2, true],
    ])
    expect(await head(mine[0])).toEqual([0x52, 0x02])
    expect(await opened(a, f.att.h)).toEqual(f.data)

    await a.servers.send(room, { ch, body: 'a file', att: [f.att] })
    await pump(clock, async () => (await bodies(b, room, ch)).includes('a file'), 'bob has it')
    await b.dms.blobs.download(f.att)
    await pump(clock, async () => !!(await b.dms.blobs.record(f.att.h))?.done, 'bob downloaded')
    const theirs = await parts(b, f.att.h)
    expect(theirs.length).toBe(3)
    expect(theirs.every(p => p.sealed === true)).toBe(true)
    expect(await opened(b, f.att.h)).toEqual(f.data)
    expect((await b.dms.blobs.record(f.att.h))?.type).toBe('image/png')

    // With nothing sealed on a device, what it stores from then on is kept as it was.
    await a.servers.setStore(room, false)
    await pump(clock, () => !b.store.sealing.room(room), 'bob follows again')
    const g = await fileOf(5, 1000, 'plain.bin')
    await a.dms.blobs.putOwn(new Blob([g.data as BlobPart]), g.hashed, room)
    expect((await a.dms.blobs.record(g.att.h))?.file instanceof Blob).toBe(true)
    expect(await parts(a, g.att.h)).toEqual([])
    expect(await opened(a, f.att.h)).toEqual(f.data)

    // A device that lost its key drops the files it stored sealed.
    stopMember(b)
    await b.store.sealing.stored.delete('meta', DEVICE_KEYS_META)
    b.store.close()
    const { P2pStore } = await import('../p2p/db')
    const again = await P2pStore.create(b.db)
    await dropSealed(again.db)
    expect(await again.db.get('blobs', f.att.h)).toBeUndefined()
    expect(await again.db.count('blob_parts', partRange(f.att.h))).toBe(0)
    again.close()
  }, 90_000)
})

import { afterEach, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { Hub, makeNode, ManualClock, settle, waitFor } from './p2p_net'
import type { P2pNode } from '../p2p/node'
import type { P2pStore } from '../p2p/db'
import { b64u, fromB64u } from '../p2p/canonical'
import {
  Blobs,
  BULK,
  BulkLink,
  HOLDERS_KEPT,
  MISMATCH_TEXT,
  partRange,
  thumbBytes,
  type BlobsDeps,
} from '../p2p/blobs'
import { gifFrames, GIF_FRAMES, imageSize, inlineImageOk } from '../sniff'
import { imageFits, UrlCache } from '../p2p/files'
import { BLOCK, blobRoot, EMPTY_ROOT, hashBlob, hashBytes, TAG_BLOB } from '../p2p/hashing'
import { buildEvent, validate } from '../p2p/event_v1'
import { LIMITS as EV, type Attachment } from '../p2p/content'
import { AUTO_PAUSED_TEXT, Dms, dmRoomId, loadMessages, type DmDeps } from '../p2p/dm'
import { insertEvent } from '../p2p/dag'
import { keyId, newKeyPair, signCert } from '../p2p/keys'

// Real-time tests (sessions, IndexedDB): budgets for a loaded machine.
setDefaultTimeout(60_000)

// P2P attachments (note section 5): block hashing, the bulk pipe, multi-source downloads with
// per-block checks, resume, the serving gate and deletion on redaction.

interface Node {
  node: P2pNode
  store: P2pStore
  db: string
}

const stops: (() => void)[] = []
afterEach(() => {
  for (const s of stops.splice(0)) s()
})

// Waits for the state, for most of the test budget (a loaded run is slow, not wrong).
const eventually = async (ok: () => Promise<boolean>, what: string, ms = 50_000) => {
  const end = Date.now() + ms
  while (!(await ok())) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`)
    await new Promise(r => setTimeout(r, 2))
  }
}

// Deterministic bytes, different per seed.
const bytes = (n: number, seed = 1) => {
  const out = new Uint8Array(n)
  let x = seed * 2654435761
  for (let i = 0; i < n; i += 1) {
    x = (x * 1103515245 + 12345) >>> 0
    out[i] = x >>> 24
  }
  return out
}

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13])

// A JPEG header (JFIF, a baseline frame header saying `w` x `h`, a scan header) and a few bytes
// of scan data: enough for a header check, not a real image.
const jpeg = (w: number, h: number) =>
  new Uint8Array([
    0xff,
    0xd8,
    0xff,
    0xe0,
    0x00,
    0x10,
    0x4a,
    0x46,
    0x49,
    0x46,
    0x00,
    0x01,
    0x01,
    0x00,
    0x00,
    0x01,
    0x00,
    0x01,
    0x00,
    0x00,
    0xff,
    0xc0,
    0x00,
    0x11,
    0x08,
    h >> 8,
    h & 0xff,
    w >> 8,
    w & 0xff,
    0x03,
    0x01,
    0x22,
    0x00,
    0x02,
    0x11,
    0x01,
    0x03,
    0x11,
    0x01,
    0xff,
    0xda,
    0x00,
    0x0c,
    0x03,
    0x01,
    0x00,
    0x02,
    0x11,
    0x03,
    0x11,
    0x00,
    0x3f,
    0x00,
    0x12,
    0x34,
    0xff,
    0xd9,
  ])

const same = (a: Uint8Array, b: Uint8Array) =>
  a.length === b.length && a.every((v, i) => v === b[i])

const contentsOf = async (blob: Blob | null) =>
  blob ? new Uint8Array(await blob.arrayBuffer()) : new Uint8Array(0)

const befriend = async (a: Node, b: Node) => {
  await a.node.addContact(await b.node.myCard())
  await waitFor(() => b.node.contact(a.node.ik)?.state === 'incoming', 'request')
  await b.node.accept(a.node.ik)
  await waitFor(
    () => a.node.readySessions(b.node.ik).length > 0 && b.node.readySessions(a.node.ik).length > 0,
    'session'
  )
}

const node = async (hub: Hub, name: string, clock: ManualClock) => {
  const n = await makeNode(hub, name, { clock })
  stops.push(() => n.node.stop())
  await n.node.start()
  return n
}

// A bare file manager on a node, with the gate given by the test.
const blobsOn = (n: Node, clock: ManualClock, deps: Partial<BlobsDeps> = {}) => {
  const b = new Blobs({
    node: n.node,
    store: n.store,
    clock,
    entitled: async () => true,
    members: async () => [],
    ...deps,
  })
  stops.push(() => b.stop())
  return b
}

const attOf = async (data: Uint8Array, name = 'file.bin'): Promise<Attachment> => {
  const h = await hashBytes(data)
  return { h: h.h, size: h.size, blocks: h.blocks.length, name, mime: 'application/octet-stream' }
}

describe('hashing', () => {
  test('root over the block hashes, with fixed vectors', async () => {
    const reference = (data: Uint8Array) => {
      const root = createHash('sha256')
      root.update(TAG_BLOB)
      const size = Buffer.alloc(8)
      size.writeBigUInt64BE(BigInt(data.length))
      root.update(size)
      for (let at = 0; at < data.length; at += BLOCK)
        root.update(
          createHash('sha256')
            .update(data.subarray(at, at + BLOCK))
            .digest()
        )
      return root.digest('base64url')
    }
    for (const n of [0, 1, BLOCK - 1, BLOCK, BLOCK + 1, 3 * BLOCK + 17]) {
      const data = bytes(n, n + 3)
      const h = await hashBytes(data)
      expect(h.h).toBe(reference(data))
      expect(h.blocks.length).toBe(Math.ceil(n / BLOCK))
      // Streaming from a Blob gives the same.
      expect(await hashBlob(new Blob([data as BlobPart]))).toEqual(h)
    }
    expect((await hashBytes(new Uint8Array(0))).h).toBe(
      'JIWYWrg2GHFUC4uIw8s10CCw-4Je33bXK9jAHeuhmK4'
    )
    expect((await hashBytes(new TextEncoder().encode('abc'))).h).toBe(
      reference(new TextEncoder().encode('abc'))
    )
    // The size is part of the root: same blocks, other size, other root.
    const blocks = [fromB64u((await hashBytes(bytes(10))).blocks[0])]
    expect(blobRoot(10, blocks)).not.toBe(blobRoot(11, blocks))
  })

  test('attachment schema in messages', () => {
    const ik = newKeyPair()
    const dk = newKeyPair()
    const me = keyId(ik.pk)
    const other = keyId(newKeyPair().pk)
    const room = dmRoomId(me, other)
    const cert = signCert(ik, dk.pk, 1, 'Test')
    const auth = {
      room,
      members: [me, other],
      devices: () => ({ certs: [cert], revocations: [] }),
    }
    const att: Attachment = {
      h: b64u(new Uint8Array(32)),
      size: BLOCK + 1,
      blocks: 2,
      name: 'a.png',
      mime: 'image/png',
    }
    const check = (c: object) =>
      validate(buildEvent({ ik, dk }, room, 'msg', c as never, [], 0, 1_700_000_000_000).wire, auth)
        .ok
    expect(check({ body: '', att: [att] })).toBe(true)
    expect(check({ body: 'x', att: [{ ...att, spoiler: true, w: 10, h_px: 20, dur: 3000 }] })).toBe(
      true
    )
    expect(check({ body: '' })).toBe(false)
    expect(check({ body: 'x', att: [] })).toBe(false)
    expect(check({ body: 'x', att: [{ ...att, blocks: 3 }] })).toBe(false)
    expect(check({ body: 'x', att: [{ ...att, h: 'short' }] })).toBe(false)
    expect(check({ body: 'x', att: [{ ...att, spoiler: false }] })).toBe(false)
    // A field a newer version adds is kept unread (forward compatibility).
    expect(check({ body: 'x', att: [{ ...att, extra: 1 }] })).toBe(true)
    expect(check({ body: 'x', att: [att, att] })).toBe(false)
    expect(check({ body: 'x', att: [{ ...att, name: '' }] })).toBe(false)
    expect(check({ body: 'x', att: [{ ...att, mime: 'text/html; x' }] })).toBe(false)
    expect(check({ body: 'x', att: [{ ...att, thumb: b64u(new Uint8Array(EV.thumb + 1)) }] })).toBe(
      false
    )
    // 50 files per message, no more.
    const many = (n: number) =>
      Array.from({ length: n }, (_, i) => ({ ...att, h: b64u(new Uint8Array(32).fill(i + 1)) }))
    expect(check({ body: '', att: many(EV.att) })).toBe(true)
    expect(check({ body: '', att: many(EV.att + 1) })).toBe(false)
    // No size limit per file.
    const huge = 5 * 1024 ** 4
    expect(check({ body: '', att: [{ ...att, size: huge, blocks: huge / BLOCK }] })).toBe(true)
    // Thumbnails must be JPEG bytes to be shown at all.
    expect(thumbBytes(b64u(jpeg(160, 120)))).not.toBeNull()
    expect(thumbBytes(b64u(new Uint8Array([0x3c, 0x73, 0x76, 0x67])))).toBeNull()
    expect(thumbBytes(b64u(new Uint8Array(7000).fill(0xff)))).toBeNull()
    // Zero-length files: only the one empty root.
    expect(check({ body: '', att: [{ ...att, size: 0, blocks: 0 }] })).toBe(false)
    expect(check({ body: '', att: [{ ...att, h: EMPTY_ROOT, size: 0, blocks: 0 }] })).toBe(true)
  })

  test('thumbnails: the header size is checked before anything is decoded', () => {
    const ok = thumbBytes(b64u(jpeg(160, 120)))
    expect(ok && { w: ok.w, h: ok.h }).toEqual({ w: 160, h: 120 })
    // A few hundred bytes that claim 65500 x 65500 pixels (17 GB once decoded).
    const bomb = jpeg(65500, 65500)
    expect(bomb.length).toBeLessThan(400)
    expect(imageSize(bomb)).toEqual({ w: 65500, h: 65500 })
    expect(thumbBytes(b64u(bomb))).toBeNull()
    expect(thumbBytes(b64u(jpeg(1025, 10)))).toBeNull()
    expect(thumbBytes(b64u(jpeg(1024, 1024)))).not.toBeNull()
    expect(thumbBytes(b64u(jpeg(0, 10)))).toBeNull()
    // No frame header before the image data, or cut short: no size, not shown.
    expect(thumbBytes(b64u(jpeg(10, 10).subarray(0, 26)))).toBeNull()
    expect(thumbBytes(b64u(new Uint8Array([0xff, 0xd8, 0xff, 0xda, 0, 4, 0, 0])))).toBeNull()
    // Over 6 KiB, even when small.
    const padded = new Uint8Array(7000)
    padded.set(jpeg(10, 10))
    expect(thumbBytes(b64u(padded))).toBeNull()
    // The other formats' headers.
    const png = new Uint8Array(24)
    png.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52])
    new DataView(png.buffer).setUint32(16, 70000)
    new DataView(png.buffer).setUint32(20, 3)
    expect(imageSize(png)).toEqual({ w: 70000, h: 3 })
    const gif = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x10, 0x27, 0x05, 0x00])
    expect(imageSize(gif)).toEqual({ w: 10000, h: 5 })
    const webp = new Uint8Array(30)
    webp.set(new TextEncoder().encode('RIFF\0\0\0\0WEBPVP8X'))
    webp.set([0xff, 0xff, 0x00, 0x09, 0x00, 0x00], 24)
    expect(imageSize(webp)).toEqual({ w: 65536, h: 10 })
    expect(imageSize(new Uint8Array([1, 2, 3]))).toBeNull()
  })
})

describe('storage', () => {
  test('schema v3 adds the file stores and the attachment index to a v2 database', async () => {
    const { openDB } = await import('idb')
    const { UPGRADES, P2pStore: Store, DB_VERSION } = await import('../p2p/db')
    const name = `upgrade-v3-${Math.random()}`
    const v2 = await openDB(name, 2, {
      upgrade(db, _old, _new, tx) {
        UPGRADES[0](db as never, tx as never)
        UPGRADES[1](db as never, tx as never)
      },
    })
    await v2.put('events', { id: 'e1', room: 'r', type: 'msg', sortKey: 'k', seq: 1 })
    await v2.put('meta', 2, 'schema')
    v2.close()
    const store = await Store.open(name)
    expect(store.db.version).toBe(DB_VERSION)
    expect(store.db.objectStoreNames.contains('blobs')).toBe(true)
    expect(store.db.objectStoreNames.contains('blob_parts')).toBe(true)
    expect((await store.event('e1'))?.room).toBe('r')
    expect(await store.db.countFromIndex('events', 'att', 'x')).toBe(0)
    expect(await store.meta('schema')).toBe(DB_VERSION)
    store.close()
    const again = await Store.open(name)
    expect((await again.event('e1'))?.room).toBe('r')
    again.close()
  })
})

describe('bulk transfers', () => {
  test('files probed for holders and never downloaded are not kept forever', async () => {
    const clock = new ManualClock()
    const hub = new Hub()
    const a = await node(hub, 'Alice', clock)
    const bb = blobsOn(a, clock, { members: async () => [] })
    const probe = (h: string) =>
      (bb as unknown as { probe: (h: string) => Promise<unknown> }).probe(h)
    const holders = (bb as unknown as { holders: Map<string, unknown> }).holders
    for (let i = 0; i < HOLDERS_KEPT + 100; i += 1) await probe(b64u(bytes(32, i + 1)))
    expect(holders.size).toBe(HOLDERS_KEPT)
    clock.t += BULK.probeMs
    await probe(b64u(bytes(32, 9999)))
    expect(holders.size).toBe(1)
  })

  test('multi-source: blocks come from every holder and the file matches', async () => {
    const clock = new ManualClock()
    const hub = new Hub()
    const a = await node(hub, 'Alice', clock)
    const b = await node(hub, 'Bob', clock)
    const c = await node(hub, 'Carol', clock)
    await befriend(a, b)
    await befriend(c, b)
    const data = bytes(6 * BLOCK + 1234, 7)
    const att = await attOf(data)
    const ba = blobsOn(a, clock)
    const bc = blobsOn(c, clock)
    await ba.putOwn(new Blob([data as BlobPart]), await hashBytes(data))
    await bc.putOwn(new Blob([data as BlobPart]), await hashBytes(data))
    const bb = blobsOn(b, clock, { members: async () => [a.node.ik, c.node.ik] })
    await bb.download(att)
    await eventually(async () => !!(await bb.record(att.h))?.done, 'download')
    expect(same(await contentsOf(await bb.file(att.h)), data)).toBe(true)
    const served = (x: Blobs) => x.pipes.reduce((n, l) => n + l.bytes, 0)
    expect(served(ba)).toBeGreaterThan(BLOCK)
    expect(served(bc)).toBeGreaterThan(BLOCK)
    // The chat sessions carried none of it.
    for (const s of b.node.readySessions(a.node.ik)) expect(s.strikes).toBe(0)
    expect(hub.bulkDials).toBeGreaterThan(0)
  }, 60_000)

  test('a corrupt block is refused and fetched from another holder', async () => {
    const clock = new ManualClock()
    const hub = new Hub()
    const a = await node(hub, 'Alice', clock)
    const b = await node(hub, 'Bob', clock)
    const c = await node(hub, 'Carol', clock)
    await befriend(a, b)
    await befriend(c, b)
    const data = bytes(3 * BLOCK, 9)
    const att = await attOf(data)
    const bad = data.slice()
    for (let i = 0; i < 3; i += 1) bad[i * BLOCK + 5] ^= 1
    const ba = blobsOn(a, clock)
    const bc = blobsOn(c, clock)
    // Alice serves bytes that don't match the hashes she claims.
    await ba.putOwn(new Blob([bad as BlobPart]), await hashBytes(data))
    await bc.putOwn(new Blob([data as BlobPart]), await hashBytes(data))
    const bb = blobsOn(b, clock, { members: async () => [a.node.ik, c.node.ik] })
    await bb.download(att)
    await eventually(async () => !!(await bb.record(att.h))?.done, 'download')
    expect(same(await contentsOf(await bb.file(att.h)), data)).toBe(true)
    const toAlice = bb.pipes.find(l => l.ik === a.node.ik) as BulkLink
    expect(toAlice.strikes).toBeGreaterThan(0)
  }, 60_000)

  test('a download resumes after the pipe drops mid-block, keeping stored blocks', async () => {
    const clock = new ManualClock()
    const hub = new Hub()
    const a = await node(hub, 'Alice', clock)
    const b = await node(hub, 'Bob', clock)
    await befriend(a, b)
    const data = bytes(5 * BLOCK + 99, 11)
    const att = await attOf(data)
    const ba = blobsOn(a, clock)
    await ba.putOwn(new Blob([data as BlobPart]), await hashBytes(data))
    const bb = blobsOn(b, clock, { members: async () => [a.node.ik] })
    await bb.download(att)
    // Cut the pipe in the middle of a block, once two are stored.
    await eventually(async () => ((await bb.record(att.h))?.have ?? 0) >= 2, 'two blocks')
    await eventually(
      async () => bb.pipes.some(l => [...l.fetches.values()].some(f => f.got > 0)),
      'mid-block'
    )
    const kept = (await bb.record(att.h))?.have ?? 0
    hub.bulkWires[0].a.close()
    await eventually(
      async () => bb.pipes.every(l => l.state !== 'open' || hub.bulkWires.length > 1),
      'closed'
    )
    // A new pipe takes over and the rest arrives.
    bb.kick()
    await eventually(async () => !!(await bb.record(att.h))?.done, 'download')
    expect(hub.bulkWires.length).toBeGreaterThan(1)
    expect(kept).toBeGreaterThanOrEqual(2)
    expect(same(await contentsOf(await bb.file(att.h)), data)).toBe(true)
    // Every block is stored once; the one cut in the middle was fetched again whole.
    const parts = await b.store.db.getAllKeys('blob_parts', partRange(att.h))
    expect(parts.length).toBe(6)
  }, 60_000)

  test('a download resumes after a reload', async () => {
    const clock = new ManualClock()
    const hub = new Hub()
    const a = await node(hub, 'Alice', clock)
    const b = await node(hub, 'Bob', clock)
    await befriend(a, b)
    const data = bytes(3 * BLOCK, 13)
    const att = await attOf(data)
    // Nobody has it yet: the download waits.
    const ba = blobsOn(a, clock)
    const bb = blobsOn(b, clock, { members: async () => [a.node.ik] })
    await bb.download(att)
    await eventually(async () => bb.view(att.h, att.size).state === 'waiting', 'waiting')
    expect(bb.view(att.h, att.size).holders).toBe(0)
    bb.stop()
    // Alice gets the file; Bob's next start picks the download up again.
    await ba.putOwn(new Blob([data as BlobPart]), await hashBytes(data))
    const again = blobsOn(b, clock, { members: async () => [a.node.ik] })
    await again.resume()
    await eventually(async () => !!(await again.record(att.h))?.done, 'download')
    expect(same(await contentsOf(await again.file(att.h)), data)).toBe(true)
  }, 60_000)

  test('a request floods or asks for unrequested data: strikes on the pipe, never the session', async () => {
    const clock = new ManualClock()
    const hub = new Hub()
    const a = await node(hub, 'Alice', clock)
    const b = await node(hub, 'Bob', clock)
    await befriend(a, b)
    const data = bytes(2 * BLOCK, 3)
    const att = await attOf(data)
    const ba = blobsOn(a, clock)
    await ba.putOwn(new Blob([data as BlobPart]), await hashBytes(data))
    const bb = blobsOn(b, clock, { members: async () => [a.node.ik] })
    expect(await bb.availability(att.h)).toBe(1)
    const link = bb.pipes[0]
    const theirs = () => ba.pipes.find(l => l.ik === b.node.ik) as BulkLink
    // Part kinds and message types from a newer version cost nothing; an answer nobody asked
    // for does.
    const raw = link as unknown as { seal: (parts: Uint8Array[]) => Promise<void> }
    await raw.seal([new Uint8Array([9, 1, 2])])
    for (let i = 0; i < 5; i += 1) await link.send({ t: 'blob_what', extra: i })
    await link.send({ t: 'blob_has_ok', rid: 999, have: [] })
    await eventually(async () => theirs().strikes >= 1, 'strikes')
    expect(theirs().strikes).toBe(1)
    // None of it reached the chat sessions.
    for (const s of a.node.readySessions(b.node.ik)) expect(s.strikes).toBe(0)
    for (const s of b.node.readySessions(a.node.ik)) expect(s.strikes).toBe(0)
    // Twenty strikes close the pipe and keep that peer off the bulk pipes for a while.
    for (let i = 0; i < 20; i += 1)
      await link.send({ t: 'blob_get', h: 'bad', block: 0 }).catch(() => {})
    await eventually(async () => link.state === 'closed', 'closed')
    bb.kick()
    expect(await bb.availability(att.h)).toBe(0)
    expect(a.node.readySessions(b.node.ik).length).toBeGreaterThan(0)
  }, 60_000)

  test('block requests past the window are refused with a strike', async () => {
    const clock = new ManualClock()
    const hub = new Hub()
    const a = await node(hub, 'Alice', clock)
    const b = await node(hub, 'Bob', clock)
    await befriend(a, b)
    const data = bytes(2 * BLOCK, 4)
    const att = await attOf(data)
    const ba = blobsOn(a, clock)
    await ba.putOwn(new Blob([data as BlobPart]), await hashBytes(data))
    const bb = blobsOn(b, clock, { members: async () => [a.node.ik] })
    expect(await bb.availability(att.h)).toBe(1)
    const link = bb.pipes[0]
    const theirs = ba.pipes.find(l => l.ik === b.node.ik) as BulkLink
    await Promise.all(
      [0, 1, 0, 1, 0, 1].map(block => link.send({ t: 'blob_get', h: att.h, block }))
    )
    await eventually(async () => theirs.strikes > 0, 'window strike')
    for (const s of a.node.readySessions(b.node.ik)) expect(s.strikes).toBe(0)
  }, 60_000)

  // Every bulk pipe on both sides: no strikes, none closed for strikes.
  const clean = (...xs: Blobs[]) => {
    for (const x of xs) for (const l of [...x.pipes, ...x.incoming]) expect(l.strikes).toBe(0)
  }

  // Holds the frames a holder sends on a bulk pipe until `release()`, which delivers them in
  // order (frames must arrive in counter order).
  const hold = (hub: Hub, at = 0, after = 0) => {
    const w = hub.bulkWires[at]
    const stash: Uint8Array[] = []
    let seen = 0
    w.wire.tamper = (d, from) => {
      if (from !== 'b') return d
      seen += 1
      if (seen <= after) return d
      stash.push(d)
      return null
    }
    return {
      stash,
      release() {
        w.wire.tamper = undefined
        for (const d of stash.splice(0))
          (w.a as typeof w.a & { deliver: (x: Uint8Array) => void }).deliver(d)
      },
    }
  }

  test('several downloads from one holder share its credit: all finish, no strikes, no ban', async () => {
    const clock = new ManualClock()
    const hub = new Hub()
    const a = await node(hub, 'Alice', clock)
    const b = await node(hub, 'Bob', clock)
    await befriend(a, b)
    const ba = blobsOn(a, clock)
    const bb = blobsOn(b, clock, { members: async () => [a.node.ik] })
    const files = [1, 2, 3, 4, 5].map(i => bytes(i < 4 ? 4 * BLOCK : 2000 * i, 60 + i))
    const atts: Attachment[] = []
    for (const f of files) {
      await ba.putOwn(new Blob([f as BlobPart]), await hashBytes(f))
      atts.push(await attOf(f))
    }
    // All at once, as auto-download starts them.
    await Promise.all(atts.map(x => bb.download(x)))
    await eventually(
      async () => (await Promise.all(atts.map(x => bb.record(x.h)))).every(r => r?.done),
      'all downloads'
    )
    for (let i = 0; i < files.length; i += 1)
      expect(same(await contentsOf(await bb.file(atts[i].h)), files[i])).toBe(true)
    clean(ba, bb)
    // Nobody was banned: one pipe all along, still open.
    expect(hub.bulkDials).toBe(1)
    expect(bb.pipes[0].state).toBe('open')
    expect(bb.pipes[0].maxQueued).toBeLessThan(BULK.queueBytes + 3 * BLOCK)
  }, 60_000)

  test('cancelling mid-block costs the holder nothing, and the next download from them works', async () => {
    const clock = new ManualClock()
    const hub = new Hub()
    const a = await node(hub, 'Alice', clock)
    const b = await node(hub, 'Bob', clock)
    await befriend(a, b)
    const data = bytes(4 * BLOCK, 71)
    const att = await attOf(data)
    const ba = blobsOn(a, clock)
    await ba.putOwn(new Blob([data as BlobPart]), await hashBytes(data))
    const bb = blobsOn(b, clock, { members: async () => [a.node.ik] })
    expect(await bb.availability(att.h)).toBe(1)
    // Alice's frames stop after 20 (the has answer, the meta answer and some chunks).
    const h = hold(hub, 0, 20)
    await bb.download(att)
    await eventually(async () => h.stash.length > 100, 'blocks held')
    const link = bb.pipes[0]
    expect([...link.fetches.values()].some(f => f.got > 0 && f.got < BLOCK)).toBe(true)
    await bb.cancel(att.h)
    // The rest of both blocks arrives late, after the cancel.
    h.release()
    await eventually(async () => link.abandoned.size === 0, 'late chunks dropped')
    clean(ba, bb)
    // Download it again from the same holder over the same pipe.
    await bb.download(att)
    await eventually(async () => !!(await bb.record(att.h))?.done, 'download')
    expect(same(await contentsOf(await bb.file(att.h)), data)).toBe(true)
    clean(ba, bb)
    expect(hub.bulkDials).toBe(1)
  }, 60_000)

  test('a stalled block is cancelled and asked for again from the same holder', async () => {
    const clock = new ManualClock()
    const hub = new Hub()
    const a = await node(hub, 'Alice', clock)
    const b = await node(hub, 'Bob', clock)
    await befriend(a, b)
    const data = bytes(3 * BLOCK + 5, 72)
    const att = await attOf(data)
    const ba = blobsOn(a, clock)
    await ba.putOwn(new Blob([data as BlobPart]), await hashBytes(data))
    const bb = blobsOn(b, clock, { members: async () => [a.node.ik] })
    expect(await bb.availability(att.h)).toBe(1)
    const link = bb.pipes[0]
    // Everything Alice sends after the meta answer is held: the blocks stall.
    const h = hold(hub, 0, 2)
    await bb.download(att)
    await eventually(async () => link.fetches.size === 2 && h.stash.length > 0, 'requests out')
    // Time moves on until both stall timers ran (one may be armed after a first advance).
    await eventually(async () => {
      await clock.advance(BULK.stallMs)
      return link.abandoned.size >= 2
    }, 'stalled blocks cancelled')
    // The network comes back: the stalled blocks arrive in full, late, and are dropped.
    h.release()
    await eventually(async () => !!(await bb.record(att.h))?.done, 'download')
    expect(same(await contentsOf(await bb.file(att.h)), data)).toBe(true)
    clean(ba, bb)
    expect(link.state).toBe('open')
  }, 60_000)

  test('a wrong size claim never completes and never blocks the real file', async () => {
    const clock = new ManualClock()
    const hub = new Hub()
    const a = await node(hub, 'Alice', clock)
    const b = await node(hub, 'Bob', clock)
    await befriend(a, b)
    const data = bytes(BLOCK + 9, 73)
    const att = await attOf(data)
    const ba = blobsOn(a, clock)
    await ba.putOwn(new Blob([data as BlobPart]), await hashBytes(data))
    const bb = blobsOn(b, clock, { members: async () => [a.node.ik] })
    const err = (p: Promise<unknown>) =>
      p.then(
        () => 'ok',
        (e: Error) => e.message
      )
    // Zero length with a real file's root: refused, nothing stored.
    expect(await err(bb.download({ h: att.h, size: 0 }))).toBe(MISMATCH_TEXT)
    expect(await bb.record(att.h)).toBeUndefined()
    // Another size: the holder's hashes don't add up to the root with it, so it fails.
    await bb.download({ h: att.h, size: att.size + 1 })
    await eventually(async () => bb.view(att.h, att.size + 1).state === 'failed', 'failed')
    expect((await bb.record(att.h))?.done).toBe(false)
    // The real one still downloads, with no strikes for the holder.
    await bb.download(att)
    await eventually(async () => !!(await bb.record(att.h))?.done, 'download')
    expect(same(await contentsOf(await bb.file(att.h)), data)).toBe(true)
    clean(ba, bb)
    // The empty file has one root and completes with nothing to fetch.
    await bb.download({ h: EMPTY_ROOT, size: 0 })
    await eventually(async () => !!(await bb.record(EMPTY_ROOT))?.done, 'empty file')
    expect((await bb.file(EMPTY_ROOT))?.size).toBe(0)
  }, 60_000)

  test('pipes still opening count against the cap, per session and per identity', async () => {
    const clock = new ManualClock()
    const hub = new Hub()
    const a = await node(hub, 'Alice', clock)
    const b = await node(hub, 'Bob', clock)
    await befriend(a, b)
    const ba = blobsOn(a, clock)
    const s = b.node.readySessions(a.node.ik)[0]
    // Bob opens pipes and never says a word on them.
    const pipes = [await b.node.dialBulk(s), await b.node.dialBulk(s), await b.node.dialBulk(s)]
    await settle()
    expect(ba.incoming.length).toBe(2)
    expect(hub.bulkWires.map(w => w.a.closed)).toEqual([false, false, true])
    // Closing one makes room again.
    pipes[0].close()
    await settle()
    expect(ba.incoming.length).toBe(1)
    await b.node.dialBulk(s)
    await settle()
    expect(ba.incoming.length).toBe(2)
    // And per identity, across its sessions.
    const hub2 = new Hub()
    const c = await node(hub2, 'Carol', clock)
    const d = await node(hub2, 'Dan', clock)
    await befriend(c, d)
    const bc = blobsOn(c, clock, { limits: { inPeer: 1 } })
    const s2 = d.node.readySessions(c.node.ik)[0]
    await d.node.dialBulk(s2)
    await d.node.dialBulk(s2)
    await settle()
    expect(bc.incoming.length).toBe(1)
    expect(hub2.bulkWires.map(w => w.a.closed)).toEqual([false, true])
  }, 60_000)

  test('text-only mode answers "missing" without a strike', async () => {
    const clock = new ManualClock()
    const hub = new Hub()
    const a = await node(hub, 'Alice', clock)
    const b = await node(hub, 'Bob', clock)
    await befriend(a, b)
    const data = bytes(BLOCK, 74)
    const att = await attOf(data)
    let on = true
    const ba = blobsOn(a, clock, { enabled: () => on })
    await ba.putOwn(new Blob([data as BlobPart]), await hashBytes(data))
    const bb = blobsOn(b, clock, { members: async () => [a.node.ik] })
    expect(await bb.availability(att.h)).toBe(1)
    on = false
    const link = bb.pipes[0]
    const has = await link.call({ t: 'blob_has', hs: [att.h] }, 'blob_has_ok')
    expect(has?.have).toEqual([])
    const meta = await link.call({ t: 'blob_meta', h: att.h, from: 0 }, 'blob_meta_ok')
    expect(meta).toMatchObject({ t: 'blob_no', why: 'missing' })
    clean(ba, bb)
  }, 60_000)

  test('a pipe due for new keys is replaced while a download goes on', async () => {
    const clock = new ManualClock()
    const hub = new Hub()
    const a = await node(hub, 'Alice', clock)
    const b = await node(hub, 'Bob', clock)
    await befriend(a, b)
    const data = bytes(8 * BLOCK, 75)
    const att = await attOf(data)
    const ba = blobsOn(a, clock)
    await ba.putOwn(new Blob([data as BlobPart]), await hashBytes(data))
    const bb = blobsOn(b, clock, {
      members: async () => [a.node.ik],
      limits: { pipeBytes: 2 * BLOCK },
    })
    await bb.download(att)
    await eventually(async () => !!(await bb.record(att.h))?.done, 'download')
    expect(same(await contentsOf(await bb.file(att.h)), data)).toBe(true)
    expect(hub.bulkDials).toBeGreaterThan(1)
    clean(ba, bb)
  }, 60_000)

  test('the work per block stays the same, whatever the size of the file', async () => {
    const clock = new ManualClock()
    const hub = new Hub()
    const a = await node(hub, 'Alice', clock)
    const b = await node(hub, 'Bob', clock)
    await befriend(a, b)
    const n = 24
    const data = bytes(n * BLOCK, 76)
    const att = await attOf(data)
    const ba = blobsOn(a, clock)
    await ba.putOwn(new Blob([data as BlobPart]), await hashBytes(data))
    const bb = blobsOn(b, clock, { members: async () => [a.node.ik] })
    // Every write to the databases, with the size of the progress records written.
    const writes = new Map<string, number>()
    let recordMax = 0
    const proto = IDBObjectStore.prototype as unknown as {
      put: (this: IDBObjectStore, v: unknown, k?: IDBValidKey) => IDBRequest
    }
    const put = proto.put
    proto.put = function (v: unknown, k?: IDBValidKey) {
      const key = `${this.transaction.db.name}:${this.name}`
      writes.set(key, (writes.get(key) ?? 0) + 1)
      if (this.name === 'blobs')
        recordMax = Math.max(
          recordMax,
          JSON.stringify(v, (_, x: unknown) => (x instanceof Blob ? null : x)).length
        )
      return put.call(this, v, k)
    }
    try {
      await bb.download(att)
      await eventually(async () => !!(await bb.record(att.h))?.done, 'download')
    } finally {
      proto.put = put
    }
    const at = (n2: { db: string }, store: string) => writes.get(`${n2.db}:${store}`) ?? 0
    // Bob: one part and one small record per block, the hashes once.
    expect(at(b, 'blob_parts')).toBe(n)
    expect(at(b, 'blobs')).toBeLessThanOrEqual(n + 4)
    expect(at(b, 'blob_hashes')).toBe(1)
    expect(recordMax).toBeLessThan(400)
    // Alice serves without writing anything per block.
    expect(at(a, 'blobs') + at(a, 'blob_parts') + at(a, 'blob_hashes')).toBeLessThanOrEqual(1)
  }, 60_000)
})

// ----- In direct messages -----

interface Peer extends Node {
  dms: Dms
}

const peer = async (hub: Hub, name: string, clock: ManualClock, autoMax = 0): Promise<Peer> => {
  const n = await makeNode(hub, name, { clock })
  const dms = new Dms({ node: n.node, store: n.store, clock, autoMax: () => autoMax })
  stops.push(() => {
    dms.stop()
    n.node.stop()
  })
  await n.node.start()
  return { ...n, dms }
}

const dmFriends = async (a: Peer, b: Peer) => {
  await befriend(a, b)
  await waitFor(
    () => a.dms.online(a.dms.roomFor(b.node.ik)) && b.dms.online(b.dms.roomFor(a.node.ik)),
    'sync links'
  )
  await a.dms.open(b.node.ik)
  await b.dms.open(a.node.ik)
}

const sendFile = async (from: Peer, to: Peer, data: Uint8Array, name = 'pic.png') => {
  const hashed = await hashBytes(data)
  await from.dms.blobs.putOwn(new Blob([data as BlobPart]), hashed)
  const att: Attachment = {
    h: hashed.h,
    size: hashed.size,
    blocks: hashed.blocks.length,
    name,
    mime: 'image/png',
  }
  const id = await from.dms.send(from.dms.roomFor(to.node.ik), { body: '', att: [att] })
  return { att, id }
}

const messagesOf = async (p: Peer, other: Peer) =>
  (
    await loadMessages(p.store.db, p.dms.roomFor(other.node.ik), p.node.ik, other.node.ik, {
      limit: 1000,
    })
  ).messages

describe('attachments in direct messages', () => {
  test('send an image, download it, and keep it when the sender goes offline', async () => {
    const clock = new ManualClock()
    const hub = new Hub()
    const a = await peer(hub, 'Alice', clock)
    const b = await peer(hub, 'Bob', clock)
    await dmFriends(a, b)
    const data = new Uint8Array([...PNG, ...bytes(2 * BLOCK, 5)])
    const { att } = await sendFile(a, b, data)
    await eventually(async () => (await messagesOf(b, a)).length === 1, 'message')
    const [m] = await messagesOf(b, a)
    expect(m.att).toEqual([att])
    await b.dms.blobs.download(att)
    await eventually(async () => !!(await b.dms.blobs.record(att.h))?.done, 'download')
    const got = await b.dms.blobs.file(att.h)
    // Shown by its sniffed type, never the claimed one.
    expect(got?.type).toBe('image/png')
    expect(same(await contentsOf(got), data)).toBe(true)
    a.node.stop()
    await waitFor(() => !b.dms.online(b.dms.roomFor(a.node.ik)), 'Alice gone')
    expect(same(await contentsOf(await b.dms.blobs.file(att.h)), data)).toBe(true)
  }, 60_000)

  test('auto-download takes small files as they arrive', async () => {
    const clock = new ManualClock()
    const hub = new Hub()
    const a = await peer(hub, 'Alice', clock)
    const b = await peer(hub, 'Bob', clock, 10 * 1024 * 1024)
    await dmFriends(a, b)
    const small = await sendFile(a, b, bytes(BLOCK + 3, 21), 'small.bin')
    const big = await sendFile(a, b, bytes(11 * 1024 * 1024, 22), 'big.bin')
    await eventually(async () => !!(await b.dms.blobs.record(small.att.h))?.done, 'auto download')
    expect(await b.dms.blobs.record(big.att.h)).toBeUndefined()
  }, 60_000)

  test('the serving gate refuses a contact without the conversation', async () => {
    const clock = new ManualClock()
    const hub = new Hub()
    const a = await peer(hub, 'Alice', clock)
    const b = await peer(hub, 'Bob', clock)
    const c = await peer(hub, 'Carol', clock)
    await dmFriends(a, b)
    await dmFriends(a, c)
    const data = bytes(2 * BLOCK, 31)
    const { att } = await sendFile(a, b, data)
    expect(await a.dms.entitled(b.node.ik, att.h)).toBe(true)
    expect(await a.dms.entitled(c.node.ik, att.h)).toBe(false)
    // Carol learned the hash somehow and asks Alice directly.
    const cb = blobsOn(c, clock, { members: async () => [a.node.ik] })
    expect(await cb.availability(att.h)).toBe(0)
    const link = cb.pipes.find(l => l.ik === a.node.ik) as BulkLink
    const meta = await link.call({ t: 'blob_meta', h: att.h, from: 0 }, 'blob_meta_ok')
    expect(meta?.t).toBe('blob_no')
    await link.send({ t: 'blob_get', h: att.h, block: 0 })
    await eventually(
      async () => a.dms.blobs.pipes.some(l => l.ik === c.node.ik && l.strikes >= 2),
      'strikes'
    )
    expect(await c.store.db.count('blob_parts')).toBe(0)
    // Bob, who is in the conversation, gets it.
    await b.dms.blobs.download(att)
    await eventually(async () => !!(await b.dms.blobs.record(att.h))?.done, 'download')
  }, 60_000)

  test('a reference the requester wrote never gives access, reveals nothing and pins nothing', async () => {
    const clock = new ManualClock()
    const hub = new Hub()
    const a = await peer(hub, 'Alice', clock)
    const b = await peer(hub, 'Bob', clock)
    const c = await peer(hub, 'Carol', clock)
    await dmFriends(a, b)
    await dmFriends(a, c)
    // Alice holds a file only from her conversation with Bob.
    const data = bytes(2 * BLOCK, 81)
    const { att, id } = await sendFile(a, b, data)
    // Carol learned its hash elsewhere and posts it in her conversation with Alice.
    const planted = await c.dms.send(c.dms.roomFor(a.node.ik), { body: '', att: [att] })
    await eventually(async () => (await messagesOf(a, c)).some(m => m.id === planted), 'planted')
    expect(await a.dms.entitled(c.node.ik, att.h)).toBe(false)
    // Asking gets exactly what a file Alice never had gets.
    const unknown = (await attOf(bytes(10, 82))).h
    const cb = blobsOn(c, clock, { members: async () => [a.node.ik] })
    expect(await cb.availability(att.h)).toBe(0)
    const link = cb.pipes.find(l => l.ik === a.node.ik) as BulkLink
    for (const h of [att.h, unknown]) {
      const has = await link.call({ t: 'blob_has', hs: [h] }, 'blob_has_ok')
      expect(has?.have).toEqual([])
      const meta = await link.call({ t: 'blob_meta', h, from: 0 }, 'blob_meta_ok')
      expect(meta).toMatchObject({ t: 'blob_no', why: 'denied' })
    }
    await link.send({ t: 'blob_get', h: att.h, block: 0 })
    await eventually(
      async () =>
        a.dms.blobs.pipes
          .concat(a.dms.blobs.incoming)
          .some(l => l.ik === c.node.ik && l.strikes >= 3),
      'refused with a strike'
    )
    expect(await c.store.db.count('blob_parts')).toBe(0)
    // Carol takes hers back (a reference by anyone but the conversation's peer would keep
    // Alice's copy, which gives nobody access).
    await c.dms.redact(c.dms.roomFor(a.node.ik), planted)
    await eventually(async () => !(await messagesOf(a, c)).some(m => m.id === planted), 'unplanted')
    expect((await a.dms.blobs.record(att.h))?.done).toBe(true)
    // Bob does the same in his own conversation with Alice: his message doesn't keep Alice's
    // copy once she deletes hers.
    await b.dms.send(b.dms.roomFor(a.node.ik), { body: 'mine now', att: [att] })
    await eventually(async () => (await messagesOf(a, b)).length === 2, 'Bob posts it')
    await a.dms.redact(a.dms.roomFor(b.node.ik), id)
    await eventually(async () => (await a.dms.blobs.record(att.h)) === undefined, 'deleted')
    expect(await a.dms.entitled(b.node.ik, att.h)).toBe(false)
  }, 60_000)

  test('a message with five small files auto-downloads them all from one holder', async () => {
    const clock = new ManualClock()
    const hub = new Hub()
    const a = await peer(hub, 'Alice', clock)
    const b = await peer(hub, 'Bob', clock, 10 * 1024 * 1024)
    await dmFriends(a, b)
    const atts: Attachment[] = []
    for (let i = 0; i < 5; i += 1) {
      const f = bytes(i < 3 ? 3 * BLOCK + i : 5000 + i, 90 + i)
      await a.dms.blobs.putOwn(new Blob([f as BlobPart]), await hashBytes(f))
      atts.push(await attOf(f, `f${i}.bin`))
    }
    await a.dms.send(a.dms.roomFor(b.node.ik), { body: 'five', att: atts })
    await eventually(
      async () => (await Promise.all(atts.map(x => b.dms.blobs.record(x.h)))).every(r => r?.done),
      'auto downloads'
    )
    for (const x of [...a.dms.blobs.pipes, ...a.dms.blobs.incoming, ...b.dms.blobs.pipes])
      expect(x.strikes).toBe(0)
  }, 60_000)

  test('redaction deletes the file on both sides unless another message carries it', async () => {
    const clock = new ManualClock()
    const hub = new Hub()
    const a = await peer(hub, 'Alice', clock)
    const b = await peer(hub, 'Bob', clock)
    await dmFriends(a, b)
    const data = bytes(BLOCK + 10, 41)
    const first = await sendFile(a, b, data)
    await eventually(async () => (await messagesOf(b, a)).length === 1, 'message')
    await b.dms.blobs.download(first.att)
    await eventually(async () => !!(await b.dms.blobs.record(first.att.h))?.done, 'download')
    // The same file once more, then the first message is deleted: both keep it.
    await a.dms.send(a.dms.roomFor(b.node.ik), { body: 'again', att: [first.att] })
    await eventually(async () => (await messagesOf(b, a)).length === 2, 'second')
    await a.dms.redact(a.dms.roomFor(b.node.ik), first.id)
    await eventually(async () => (await messagesOf(b, a)).length === 1, 'redacted')
    expect((await a.dms.blobs.record(first.att.h))?.done).toBe(true)
    expect((await b.dms.blobs.record(first.att.h))?.done).toBe(true)
    // Deleting the last one removes the file and its blocks everywhere.
    const second = (await messagesOf(a, b))[0].id
    await a.dms.redact(a.dms.roomFor(b.node.ik), second)
    await eventually(
      async () => (await b.dms.blobs.record(first.att.h)) === undefined,
      'gone at Bob'
    )
    await eventually(
      async () => (await a.dms.blobs.record(first.att.h)) === undefined,
      'gone at Alice'
    )
    expect(await b.store.db.count('blob_parts')).toBe(0)
    // Nobody may fetch it any more.
    expect(await a.dms.entitled(b.node.ik, first.att.h)).toBe(false)
  }, 60_000)

  test('clearing old downloads keeps our own files', async () => {
    const clock = new ManualClock()
    const hub = new Hub()
    const a = await peer(hub, 'Alice', clock)
    const b = await peer(hub, 'Bob', clock)
    await dmFriends(a, b)
    const mine = await sendFile(b, a, bytes(100, 1), 'mine.bin')
    const theirs = await sendFile(a, b, bytes(200, 2), 'theirs.bin')
    await eventually(async () => (await messagesOf(b, a)).length === 2, 'messages')
    await b.dms.blobs.download(theirs.att)
    await eventually(async () => !!(await b.dms.blobs.record(theirs.att.h))?.done, 'download')
    expect((await b.dms.blobs.usage()).bytes).toBe(300)
    // Time passes (without running every timer of eight days).
    clock.t += 8 * 24 * 60 * 60_000
    expect(await b.dms.blobs.clearOlder(7)).toBe(1)
    expect(await b.dms.blobs.record(theirs.att.h)).toBeUndefined()
    expect((await b.dms.blobs.record(mine.att.h))?.own).toBe(true)
  }, 60_000)

  test('files are refused up front when the device has no room', async () => {
    const clock = new ManualClock()
    const hub = new Hub()
    const a = await node(hub, 'Alice', clock)
    const bb = blobsOn(a, clock, { room: async () => 3 * BLOCK })
    const att = await attOf(bytes(10, 1))
    const big = { ...att, size: 50 * BLOCK }
    expect(
      await bb.download(big).then(
        () => 'ok',
        (e: Error) => e.message
      )
    ).toContain('Not enough storage on this device')
    expect(await bb.record(big.h)).toBeUndefined()
  }, 60_000)

  test('inserting a redaction reports the freed files', async () => {
    const clock = new ManualClock()
    const hub = new Hub()
    const a = await peer(hub, 'Alice', clock)
    const ik = newKeyPair()
    const other = keyId(ik.pk)
    const room = dmRoomId(a.node.ik, other)
    const author = a.node.author() as NonNullable<ReturnType<P2pNode['author']>>
    const att = await attOf(bytes(5, 5))
    const msg = buildEvent(author, room, 'msg', { body: '', att: [att] }, [], 0, clock.now())
    const ctx = { me: a.node.ik, peer: other }
    const first = await insertEvent(a.store.db, msg.id, msg.wire, clock.now(), ctx)
    expect(first.status === 'new' && first.rec.atts).toEqual([att.h])
    const red = buildEvent(author, room, 'redact', { target: msg.id }, [msg.id], 1, clock.now())
    const res = await insertEvent(a.store.db, red.id, red.wire, clock.now(), ctx)
    expect(res.status === 'new' && res.freed).toEqual([att.h])
    expect(await a.store.db.countFromIndex('events', 'att', att.h)).toBe(0)
  }, 60_000)
})

// ----- Fix round 2 -----

const peerWith = async (
  hub: Hub,
  name: string,
  clock: ManualClock,
  extra: Partial<DmDeps> = {}
): Promise<Peer> => {
  const n = await makeNode(hub, name, { clock })
  const dms = new Dms({ node: n.node, store: n.store, clock, ...extra })
  stops.push(() => {
    dms.stop()
    n.node.stop()
  })
  await n.node.start()
  return { ...n, dms }
}

// Every file the peer has been sent is decided on (asked about, or waiting to be).
const decided = async (p: Peer) => {
  const chain = () => (p.dms as unknown as { autoChain: Promise<unknown> }).autoChain
  for (let cur = chain(); ; cur = chain()) {
    await cur
    if (cur === chain()) return
  }
}

// The serving gate answers after 15 to 50 ms, like IndexedDB on a busy phone, and never before
// the asker has decided on its files, however slow the machine makes the asker.
const slowGate = (p: Peer, asker: Peer) => {
  const orig = p.dms.entitled.bind(p.dms)
  let calls = 0
  p.dms.entitled = async (ik: string, h: string) => {
    calls += 1
    await new Promise(r => setTimeout(r, 15 + Math.random() * 35))
    await decided(asker)
    return orig(ik, h)
  }
  return () => calls
}

const linksOf = (p: Peer) => [...p.dms.blobs.pipes, ...p.dms.blobs.incoming]
const bannedOf = (p: Peer) => (p.dms.blobs as unknown as { banned: Map<string, number> }).banned

describe('many files from one holder, with a slow gate', () => {
  for (const n of [5, 25, 200])
    test(`${n} small files auto-download with no strikes`, async () => {
      const clock = new ManualClock()
      const hub = new Hub()
      const a = await peer(hub, 'Alice', clock)
      const b = await peer(hub, 'Bob', clock, 10 * 1024 * 1024)
      await dmFriends(a, b)
      const gateCalls = slowGate(a, b)
      const atts: Attachment[] = []
      for (let i = 0; i < n; i += 1) {
        // Mostly one block, every 25th two (a meta request of its own).
        const f = bytes(i % 25 === 7 ? BLOCK + i : 3000 + i, 300 + i)
        await a.dms.blobs.putOwn(new Blob([f as BlobPart]), await hashBytes(f))
        atts.push(await attOf(f, `f${i}.bin`))
      }
      // Count what Alice is asked.
      let has = 0
      let meta = 0
      let busy = 0
      const onMessage = (
        a.dms.blobs as unknown as { onMessage: (m: { t: string }, l: BulkLink) => void }
      ).onMessage
      ;(a.dms.blobs as unknown as { onMessage: unknown }).onMessage = function (
        this: unknown,
        m: { t: string },
        l: BulkLink
      ) {
        if (m.t === 'blob_has') has += 1
        if (m.t === 'blob_meta') meta += 1
        if (m.t === 'blob_has' || m.t === 'blob_meta') if (l.control >= BULK.controlMax) busy += 1
        return onMessage.call(this, m, l)
      }
      for (let at = 0; at < n; at += EV.att)
        await a.dms.send(a.dms.roomFor(b.node.ik), {
          body: `files ${at}`,
          att: atts.slice(at, at + EV.att),
        })
      await eventually(
        async () => (await Promise.all(atts.map(x => b.dms.blobs.record(x.h)))).every(r => r?.done),
        'auto downloads',
        110_000
      )
      for (const l of [...linksOf(a), ...linksOf(b)]) {
        expect(l.strikes).toBe(0)
        expect(l.state).not.toBe('closed')
      }
      expect(bannedOf(a).size).toBe(0)
      expect(bannedOf(b).size).toBe(0)
      expect(busy).toBe(0)
      // A few has requests for all of them, and a meta request only for the larger files.
      expect(has).toBeLessThanOrEqual(Math.ceil(n / BULK.hasMax) + Math.ceil(n / EV.att) + 2)
      expect(meta).toBeLessThanOrEqual(
        atts.filter(x => x.size > BULK.smallMeta * BLOCK).length + Math.ceil(n / 25)
      )
      expect(gateCalls()).toBeGreaterThan(0)
    }, 120_000)

  test('past its control limit a holder answers busy, without a strike', async () => {
    const clock = new ManualClock()
    const hub = new Hub()
    const a = await node(hub, 'Alice', clock)
    const b = await node(hub, 'Bob', clock)
    await befriend(a, b)
    const data = bytes(3000, 5)
    const att = await attOf(data)
    let open: () => void = () => {}
    const gate = new Promise<void>(r => (open = r))
    const ba = blobsOn(a, clock, { entitled: async () => (await gate, true) })
    await ba.putOwn(new Blob([data as BlobPart]), await hashBytes(data))
    const bb = blobsOn(b, clock, { members: async () => [a.node.ik] })
    const avail = bb.availability(att.h)
    await eventually(async () => bb.pipes.length === 1, 'pipe')
    const link = bb.pipes[0]
    // Raw requests past the limit, as an older or racing client might send them.
    const raw = Array.from({ length: 10 }, (_, i) =>
      link.call({ t: 'blob_meta', h: att.h, from: 0 }, 'blob_meta_ok').then(m => [i, m] as const)
    )
    await settle()
    open()
    expect(await avail).toBe(1)
    const answers = await Promise.all(raw)
    for (const [, m] of answers) expect(m?.t).toBe('blob_meta_ok')
    const theirs = ba.pipes.concat(ba.incoming).find(l => l.ik === b.node.ik) as BulkLink
    expect(theirs.strikes).toBe(0)
  }, 60_000)
})

describe('fix round 2: images, the gate, forwards, late chunks, auto-download limits', () => {
  const png = (w: number, h: number) => {
    const b = new Uint8Array(33)
    b.set(PNG)
    b.set([0x49, 0x48, 0x44, 0x52], 12)
    new DataView(b.buffer).setUint32(16, w)
    new DataView(b.buffer).setUint32(20, h)
    return b
  }
  // A GIF with a `sw` x `sh` screen and the given frames ([left, top, w, h]).
  const gif = (sw: number, sh: number, frames: number[][]) => {
    const out = [0x47, 0x49, 0x46, 0x38, 0x39, 0x61, sw & 255, sw >> 8, sh & 255, sh >> 8, 0, 0, 0]
    for (const [l, t, w, h] of frames)
      out.push(
        ...[0x21, 0xf9, 4, 0, 0, 0, 0, 0],
        ...[0x2c, l & 255, l >> 8, t & 255, t >> 8, w & 255, w >> 8, h & 255, h >> 8, 0, 2, 1, 0, 0]
      )
    out.push(0x3b)
    return new Uint8Array(out)
  }
  const webp = (w: number, h: number) => {
    const b = new Uint8Array(30)
    b.set(
      [...'RIFF'].map(c => c.charCodeAt(0)),
      0
    )
    b.set(
      [...'WEBPVP8X'].map(c => c.charCodeAt(0)),
      8
    )
    b[16] = 10
    b.set([(w - 1) & 255, ((w - 1) >> 8) & 255, (w - 1) >> 16], 24)
    b.set([(h - 1) & 255, ((h - 1) >> 8) & 255, (h - 1) >> 16], 27)
    return b
  }
  const avif = (w: number, h: number) => {
    const b = new Uint8Array(64)
    const v = new DataView(b.buffer)
    b.set(
      [...'ftypavif'].map(c => c.charCodeAt(0)),
      4
    )
    b.set(
      [...'ispe'].map(c => c.charCodeAt(0)),
      36
    )
    v.setUint32(44, w)
    v.setUint32(48, h)
    return b
  }

  test('AVIF never decodes inline: its size boxes can hide the real size', () => {
    expect(inlineImageOk(avif(1000, 1000))).toBe(false)
  })

  test('received images are header-checked against the pixel cap before any decode', async () => {
    // Fine to show inline.
    for (const b of [png(1920, 1080), jpeg(4000, 3000), webp(800, 600)])
      expect(inlineImageOk(b)).toBe(true)
    expect(
      inlineImageOk(
        gif(100, 100, [
          [0, 0, 100, 100],
          [10, 10, 50, 50],
        ])
      )
    ).toBe(true)
    // Decode bombs: a few bytes saying gigapixels.
    for (const b of [png(30000, 30000), jpeg(65000, 65000), webp(16000, 16000), avif(20000, 20000)])
      expect(inlineImageOk(b)).toBe(false)
    // A GIF with a small screen but a huge first frame (the browser grows the canvas to it).
    expect(gifFrames(gif(10, 10, [[0, 0, 60000, 60000]]))).toEqual({
      frames: 1,
      w: 60000,
      h: 60000,
    })
    expect(inlineImageOk(gif(10, 10, [[0, 0, 60000, 60000]]))).toBe(false)
    expect(
      inlineImageOk(
        gif(10, 10, [
          [1, 1, 2, 2],
          [50000, 50000, 2, 2],
        ])
      )
    ).toBe(false)
    // Too many frames.
    const many = Array.from({ length: GIF_FRAMES + 1 }, () => [0, 0, 1, 1])
    expect(inlineImageOk(gif(1, 1, many))).toBe(false)
    expect(inlineImageOk(gif(1, 1, many.slice(1)))).toBe(true)
    // No size in the header: not shown inline.
    expect(inlineImageOk(PNG)).toBe(false)
    expect(inlineImageOk(new Uint8Array([0xff, 0xd8, 0xff, 0xda, 0, 2]))).toBe(false)
    // The stored blob is checked the same way.
    expect(await imageFits(new Blob([png(30000, 30000) as BlobPart], { type: 'image/png' }))).toBe(
      false
    )
    expect(await imageFits(new Blob([png(64, 64) as BlobPart], { type: 'image/png' }))).toBe(true)
    expect(
      await imageFits(
        new Blob([gif(10, 10, [[0, 0, 60000, 60000]]) as BlobPart], { type: 'image/gif' })
      )
    ).toBe(false)
  })

  test('the serving gate does the same work for any hash, whatever we hold', async () => {
    const clock = new ManualClock()
    const hub = new Hub()
    const a = await peer(hub, 'Alice', clock)
    const b = await peer(hub, 'Bob', clock)
    const c = await peer(hub, 'Carol', clock)
    await dmFriends(a, b)
    await dmFriends(a, c)
    // Alice has a file from Carol, one she sent Carol, one Bob posted himself, and Bob also
    // asks for one she never saw.
    const fromCarol = await sendFile(c, a, bytes(4000, 401))
    const toCarol = await sendFile(a, c, bytes(4000, 402))
    const planted = await attOf(bytes(4000, 403))
    await b.dms.send(b.dms.roomFor(a.node.ik), { body: '', att: [planted] })
    const unknown = await attOf(bytes(4000, 404))
    await eventually(
      async () => (await messagesOf(a, c)).length === 2 && (await messagesOf(a, b)).length === 1,
      'messages'
    )
    const protos = [IDBIndex.prototype, IDBObjectStore.prototype] as unknown as Record<
      string,
      (...x: unknown[]) => unknown
    >[]
    const names = ['get', 'getKey', 'getAll', 'getAllKeys', 'count', 'openCursor', 'openKeyCursor']
    let reads = 0
    const saved: [Record<string, unknown>, string, unknown][] = []
    for (const p of protos)
      for (const n of names) {
        const orig = p[n]
        if (typeof orig !== 'function') continue
        saved.push([p, n, orig])
        p[n] = function (this: IDBIndex | IDBObjectStore, ...x: unknown[]) {
          const store = 'objectStore' in this && !('indexNames' in this) ? this.objectStore : this
          if ((store as IDBObjectStore).transaction.db.name === a.store.db.name) reads += 1
          return orig.apply(this, x)
        }
      }
    const work: number[] = []
    try {
      for (const h of [fromCarol.att.h, toCarol.att.h, planted.h, unknown.h]) {
        const before = reads
        expect(await a.dms.entitled(b.node.ik, h)).toBe(false)
        work.push(reads - before)
      }
    } finally {
      for (const [p, n, orig] of saved) p[n] = orig
    }
    expect(new Set(work).size).toBe(1)
    expect(work[0]).toBe(1)
    // Each distinct hash is looked up once per request, and a request has at most hasMax.
    let gates = 0
    const orig = a.dms.entitled.bind(a.dms)
    a.dms.entitled = async (ik: string, h: string) => {
      gates += 1
      return orig(ik, h)
    }
    const bb = blobsOn(b, clock, { members: async () => [a.node.ik] })
    await bb.availability(unknown.h)
    const link = bb.pipes.find(l => l.ik === a.node.ik) as BulkLink
    gates = 0
    const ans = await link.call(
      { t: 'blob_has', hs: Array.from({ length: BULK.hasMax }, () => unknown.h) },
      'blob_has_ok'
    )
    expect(ans?.have).toEqual([])
    expect(gates).toBe(1)
    const theirs = () => linksOf(a).find(l => l.ik === b.node.ik && !l.opener) as BulkLink
    expect(theirs().strikes).toBe(0)
    void link.send({
      t: 'blob_has',
      rid: 77,
      hs: Array.from({ length: BULK.hasMax + 1 }, () => unknown.h),
    })
    await eventually(async () => theirs().strikes === 1, 'too many hashes')
  }, 60_000)

  test('deleting your forward keeps the copy someone else sent you', async () => {
    const clock = new ManualClock()
    const hub = new Hub()
    const a = await peer(hub, 'Alice', clock)
    const b = await peer(hub, 'Bob', clock)
    const c = await peer(hub, 'Carol', clock)
    await dmFriends(a, b)
    await dmFriends(a, c)
    const data = bytes(BLOCK + 77, 410)
    const { att } = await sendFile(c, a, data)
    await eventually(async () => (await messagesOf(a, c)).length === 1, 'from Carol')
    await a.dms.blobs.download(att)
    await eventually(async () => !!(await a.dms.blobs.record(att.h))?.done, 'download')
    // Alice forwards it to Bob, then deletes the forward.
    const fwd = await a.dms.send(a.dms.roomFor(b.node.ik), { body: 'look', att: [att] })
    await eventually(async () => (await messagesOf(b, a)).length === 1, 'forwarded')
    // The deletion's release of its files has run (and kept this one) before the check.
    const blobs = a.dms.blobs as unknown as { release: (...x: unknown[]) => Promise<unknown> }
    const release = blobs.release.bind(blobs)
    let released = 0
    blobs.release = async (...x: unknown[]) => {
      try {
        return await release(...x)
      } finally {
        released += 1
      }
    }
    await a.dms.redact(a.dms.roomFor(b.node.ik), fwd)
    await eventually(async () => (await messagesOf(a, b)).length === 0, 'deleted')
    await eventually(async () => released > 0, 'released')
    expect((await a.dms.blobs.record(att.h))?.done).toBe(true)
    expect(same(await contentsOf(await a.dms.blobs.file(att.h)), data)).toBe(true)
    // Carol's message still lets Carol fetch it; Bob no longer can.
    expect(await a.dms.entitled(b.node.ik, att.h)).toBe(false)
  }, 60_000)

  test('late chunks of cancelled blocks never strike, however late they come', async () => {
    const clock = new ManualClock()
    const hub = new Hub()
    const a = await node(hub, 'Alice', clock)
    const b = await node(hub, 'Bob', clock)
    await befriend(a, b)
    const data = bytes(3 * BLOCK + 5, 420)
    const att = await attOf(data)
    const ba = blobsOn(a, clock)
    await ba.putOwn(new Blob([data as BlobPart]), await hashBytes(data))
    const bb = blobsOn(b, clock, { members: async () => [a.node.ik] })
    expect(await bb.availability(att.h)).toBe(1)
    const link = bb.pipes[0]
    // Alice freezes: nothing she sends arrives for minutes.
    const w = hub.bulkWires[0]
    const stash: Uint8Array[] = []
    w.wire.tamper = (d, from) => {
      if (from !== 'b') return d
      stash.push(d)
      return null
    }
    await bb.download(att)
    await eventually(async () => link.fetches.size === 2, 'requests out')
    // Stalls, asked again, stalls again, then even the holder check times out: well past the
    // old 2 x stallMs grace.
    await clock.advance(BULK.stallMs)
    await eventually(
      async () => link.abandoned.size === 2 && link.fetches.size === 2,
      'asked again'
    )
    for (let i = 0; i < 4; i += 1) await clock.advance(BULK.stallMs)
    expect([...link.abandoned.values()].flat().length).toBe(4)
    expect(link.state).toBe('open')
    w.wire.tamper = undefined
    for (const d of stash.splice(0))
      (w.a as typeof w.a & { deliver: (x: Uint8Array) => void }).deliver(d)
    await eventually(async () => !!(await bb.record(att.h))?.done, 'download')
    expect(same(await contentsOf(await bb.file(att.h)), data)).toBe(true)
    for (const x of [ba, bb]) for (const l of [...x.pipes, ...x.incoming]) expect(l.strikes).toBe(0)
    expect(link.abandoned.size).toBe(0)
  }, 60_000)

  test('past the late-chunk byte bound the pipe is replaced, with no strike and no ban', async () => {
    const clock = new ManualClock()
    const hub = new Hub()
    const a = await node(hub, 'Alice', clock)
    const b = await node(hub, 'Bob', clock)
    await befriend(a, b)
    const data = bytes(3 * BLOCK + 5, 421)
    const att = await attOf(data)
    const ba = blobsOn(a, clock)
    await ba.putOwn(new Blob([data as BlobPart]), await hashBytes(data))
    const bb = blobsOn(b, clock, {
      members: async () => [a.node.ik],
      limits: { graceBytes: BLOCK },
    })
    expect(await bb.availability(att.h)).toBe(1)
    const link = bb.pipes[0]
    hub.bulkWires[0].wire.tamper = (d, from) => (from !== 'b' ? d : null)
    await bb.download(att)
    await eventually(async () => link.fetches.size === 2, 'requests out')
    await clock.advance(BULK.stallMs)
    await eventually(async () => link.state === 'closed', 'replaced')
    expect(bannedOf({ dms: { blobs: bb } } as unknown as Peer).size).toBe(0)
    bb.kick()
    await eventually(async () => !!(await bb.record(att.h))?.done, 'download on a new pipe')
    expect(hub.bulkDials).toBe(2)
  }, 60_000)

  test('auto-download stops at the daily limit per contact and keeps storage free', async () => {
    const clock = new ManualClock()
    const hub = new Hub()
    const a = await peer(hub, 'Alice', clock)
    const c = await peer(hub, 'Carol', clock)
    let free = 4 * 1024 ** 3
    const b = await peerWith(hub, 'Bob', clock, {
      autoMax: () => 10 * 1024 * 1024,
      autoDaily: () => 10_000,
      space: async () => ({ free, quota: 8 * 1024 ** 3 }),
    })
    await dmFriends(a, b)
    await dmFriends(c, b)
    const files = [0, 1, 2].map(i => bytes(4000 + i, 430 + i))
    const atts: Attachment[] = []
    for (const f of files) {
      await a.dms.blobs.putOwn(new Blob([f as BlobPart]), await hashBytes(f))
      atts.push(await attOf(f))
    }
    await a.dms.send(a.dms.roomFor(b.node.ik), { body: 'three', att: atts })
    await eventually(async () => !!(await b.dms.blobs.record(atts[1].h))?.done, 'two fit')
    await eventually(async () => b.dms.paused.get(atts[2].h) === 'daily', 'third paused')
    expect((await b.dms.blobs.record(atts[0].h))?.done).toBe(true)
    expect(await b.dms.blobs.record(atts[2].h)).toBeUndefined()
    expect(AUTO_PAUSED_TEXT.daily).toBe('Auto-download paused for this contact today.')
    // Another contact has their own limit; the next day starts again.
    const fc = bytes(5000, 440)
    await c.dms.blobs.putOwn(new Blob([fc as BlobPart]), await hashBytes(fc))
    const ac = await attOf(fc)
    await c.dms.send(c.dms.roomFor(b.node.ik), { body: 'one', att: [ac] })
    await eventually(async () => !!(await b.dms.blobs.record(ac.h))?.done, 'Carol fits')
    // A click still downloads the paused file.
    await b.dms.blobs.download(atts[2])
    await eventually(async () => !!(await b.dms.blobs.record(atts[2].h))?.done, 'clicked')
    // Storage below max(10% of the quota, 512 MiB): nothing more by itself.
    clock.t += 24 * 60 * 60_000
    free = 800 * 1024 ** 2
    const fd = bytes(3000, 441)
    await a.dms.blobs.putOwn(new Blob([fd as BlobPart]), await hashBytes(fd))
    const ad = await attOf(fd)
    await a.dms.send(a.dms.roomFor(b.node.ik), { body: 'more', att: [ad] })
    await eventually(async () => b.dms.paused.get(ad.h) === 'space', 'space floor')
    expect(await b.dms.blobs.record(ad.h)).toBeUndefined()
    free = 4 * 1024 ** 3
    const fe = bytes(3000, 442)
    await a.dms.blobs.putOwn(new Blob([fe as BlobPart]), await hashBytes(fe))
    const ae = await attOf(fe)
    await a.dms.send(a.dms.roomFor(b.node.ik), { body: 'new day', att: [ae] })
    await eventually(async () => !!(await b.dms.blobs.record(ae.h))?.done, 'new day')
  }, 60_000)
})

describe('object URLs of shown files', () => {
  test('past the cap only URLs nothing on screen uses are revoked; one in use goes after its last user', async () => {
    const revoked: string[] = []
    const cache = new UrlCache(2, u => revoked.push(u))
    let made = 0
    const make = (h: string) => () => {
      made += 1
      return Promise.resolve(`blob:${h}`)
    }
    // Three tiles on screen at once: none is revoked, though past the cap.
    for (const h of ['a', 'b', 'c']) await cache.use(h, make(h))
    await new Promise(r => setTimeout(r, 0))
    expect(revoked).toEqual([])
    // The same file again is one URL, used twice.
    expect(await cache.use('a', make('a'))).toBe('blob:a')
    expect(made).toBe(3)
    cache.unuse('a')
    await new Promise(r => setTimeout(r, 0))
    expect(revoked).toEqual([])
    cache.unuse('b')
    await new Promise(r => setTimeout(r, 0))
    expect(revoked).toEqual(['blob:b'])
    cache.unuse('a')
    cache.unuse('c')
    await new Promise(r => setTimeout(r, 0))
    expect(revoked).toEqual(['blob:b'])
    cache.drop('a')
    await new Promise(r => setTimeout(r, 0))
    expect(revoked).toEqual(['blob:b', 'blob:a'])
  })
})

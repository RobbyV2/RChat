import { afterEach, describe, expect, test } from 'bun:test'
import { Hub, makeNode, ManualClock, waitFor } from './p2p_net'
import { identityConflict, P2pNode } from '../p2p/node'
import { P2pStore, withoutSecrets, type SelfRecord } from '../p2p/db'
import { Dms, dmRoomId, loadMessages, MOVED_TEXT, MOVING_TEXT } from '../p2p/dm'
import { buildEvent, validate } from '../p2p/event'
import { keyId, newKeyPair, signCert, signRevocation } from '../p2p/keys'
import { parseImports } from '../p2p/app'
import type { Contact } from '../p2p/contacts'
import { fromB64u, b64u } from '../p2p/canonical'
import {
  applyImport,
  alreadyImported,
  CHANGED,
  DAMAGED_DUMP,
  MOVED_DUMP,
  MOVED_EXPORT,
  dumpBytes,
  EXCLUDED,
  exportP2p,
  HEAVY_KDF,
  importKind,
  KDF_MIN,
  NEWER_DUMP,
  parseDump,
  passProblem,
  passStrength,
  readStores,
  summarize,
  summaryText,
  unlockP2p,
  WEAK_KDF,
  WRONG_PASS,
  type Dump,
  type Kdf,
  type P2pSection,
} from '../p2p/transfer'
import {
  buildConfig,
  decodeConfig,
  decodeLink,
  encodeConfig,
  FILE_LIMITS,
  linkDoc,
  PREFIX,
  sanitizeConfig,
  SECTIONS,
  TEXT_MAX,
  type SectionKey,
} from '../config_transfer'
import { EMPTY_NOTIFY } from '../notify'
import { BLOCK, blobRoot, hashBytes } from '../p2p/hashing'
import {
  exportP2pWithFiles,
  filesHead,
  filesSize,
  FILES_FRAME_MAX,
  FILES_MAGIC,
  F_BLOCK,
  F_END,
  F_FILE,
  importFiles,
  sealFilesFrame,
  unlockP2pWithFiles,
  writeFiles,
  type FilesKey,
} from '../p2p/transfer'
import { splitFile } from '../config_transfer'
import { assemble } from '../p2p/blobs'
import type { P2pDatabase } from '../p2p/db'
import { Servers } from '../p2p/server'

// Device move (note section 7): the encrypted section, the dump of every store, the three
// import cases, and what contacts and the old device see afterwards.

const KDF: Kdf = { alg: 'argon2id', m: KDF_MIN.m, t: KDF_MIN.t, p: 1 }
const PASS = 'correct horse battery'

interface Peer {
  node: P2pNode
  store: P2pStore
  dms: Dms
  servers?: Servers
  db: string
}

const live: Peer[] = []
afterEach(() => {
  for (const p of live.splice(0)) {
    p.servers?.stop()
    p.dms.stop()
    p.node.stop()
  }
})

const peerOf = (node: P2pNode, store: P2pStore, db: string, clock: ManualClock): Peer => {
  const dms = new Dms({ node, store, clock })
  const servers = new Servers({ node, store, dms, clock, random: () => 0.5 })
  void servers.start()
  const p = { node, store, dms, servers, db }
  live.push(p)
  return p
}

const makePeer = async (hub: Hub, name: string, clock: ManualClock) => {
  const n = await makeNode(hub, name, { clock })
  return peerOf(n.node, n.store, n.db, clock)
}

// A node on a database that already holds an identity (an imported one).
const openPeer = async (hub: Hub, db: string, clock: ManualClock) => {
  const store = await P2pStore.open(db)
  const node = (await P2pNode.open({
    store,
    transport: hub.transport(),
    host: 'chat.example',
    clock,
  })) as P2pNode
  return peerOf(node, store, db, clock)
}

// Waits on real time for work that runs on WebCrypto and fake-indexeddb, which a loaded full
// test run slows down a lot (the move test is the longest chain of it).
const SLOW = 40_000

const eventually = async (ok: () => Promise<boolean>, what: string, ms = 15_000) => {
  const end = Date.now() + ms
  while (!(await ok())) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`)
    await new Promise(r => setTimeout(r, 2))
  }
}

const linked = (a: Peer, b: Peer) =>
  a.dms.online(a.dms.roomFor(b.node.ik)) && b.dms.online(b.dms.roomFor(a.node.ik))

const friends = async (a: Peer, b: Peer) => {
  await a.node.start()
  await b.node.start()
  await a.node.addContact(await b.node.myCard())
  await waitFor(() => b.node.contact(a.node.ik)?.state === 'incoming', 'request')
  await b.node.accept(a.node.ik)
  await waitFor(() => linked(a, b), 'sync links')
  await a.dms.open(b.node.ik)
  await b.dms.open(a.node.ik)
}

const bodies = async (p: Peer, peerIk: string) =>
  (
    await loadMessages(p.store.db, dmRoomId(p.node.ik, peerIk), p.node.ik, peerIk, {
      limit: 100_000,
    })
  ).messages.map(m => m.body)

const text = (v: unknown) =>
  JSON.stringify(v, (_, x: unknown) => (x instanceof Uint8Array ? Array.from(x) : x))

const fresh = async () => P2pStore.open(`test-move-${Math.random()}`)

const selfOf = async (s: P2pStore) => (await s.self()) as SelfRecord

// Alice and Bob with a conversation that touches every store: messages, an edit, a reaction, a
// pin, a reply, and one message still waiting in the outbox.
const scene = async (opts: { server?: boolean } = {}) => {
  const clock = new ManualClock()
  const hub = new Hub()
  const a = await makePeer(hub, 'Alice', clock)
  const b = await makePeer(hub, 'Bob', clock)
  await friends(a, b)
  const room = dmRoomId(a.node.ik, b.node.ik)
  const first = await a.dms.send(room, { body: 'hello Bob' })
  await eventually(async () => (await bodies(b, a.node.ik)).length === 1, 'first message')
  await b.dms.send(room, { body: 'hi Alice', reply: first })
  await a.dms.react(room, first, '👍', true)
  await a.dms.pin(room, first, true)
  await a.dms.edit(room, first, 'hello there Bob')
  const file = new Uint8Array(3000).map((_, i) => i % 251)
  const hashed = await hashBytes(file)
  await a.dms.blobs.putOwn(new Blob([file as BlobPart]), hashed)
  await a.dms.send(room, {
    body: 'a file',
    att: [{ h: hashed.h, size: 3000, blocks: 1, name: 'notes.txt', mime: 'text/plain' }],
  })
  await eventually(
    async () =>
      (await bodies(a, b.node.ik)).length === 3 &&
      (await bodies(b, a.node.ik))[0] === 'hello there Bob',
    'conversation'
  )
  // With `server`: a P2P server they are both in, so Alice keeps a code she issued and Bob's
  // devices.
  const [sa, sb] = [a.servers as Servers, b.servers as Servers]
  const server = opts.server ? await sa.create('Club') : null
  if (server) {
    await sb.redeem(await sa.issueCode(server, 60 * 60_000))
    const end = Date.now() + 15_000
    while (sa.view(server)?.members.find(m => m.ik === b.node.ik)?.m !== 'join') {
      if (Date.now() > end) throw new Error('timed out waiting for Bob to join')
      await clock.advance(5_000)
    }
    // Something storage dropped here (spec 4.2): only its id stays.
    await a.store.db.put('dropped', { id: 'A'.repeat(43), room: server, layer: 'c' })
  }
  await b.node.setPaused(true)
  await waitFor(() => !a.dms.online(room), 'Bob away')
  await a.dms.send(room, { body: 'sent while Bob was away' })
  return { clock, hub, a, b, room, server }
}

describe('passphrase and section', () => {
  test('passphrase rules and the strength hint', () => {
    expect(passProblem('short', 'short')).toBe('Use at least 10 characters')
    expect(passProblem('long enough pass', 'long enough pas')).toBe("The passphrases don't match")
    expect(passProblem('long enough pass', 'long enough pass')).toBeNull()
    expect(passStrength('aaaaaaaaaaaa').score).toBe(1)
    expect(passStrength('abcdefghij').score).toBe(1)
    expect(passStrength('Tr0ub4dor&3x').score).toBeGreaterThanOrEqual(2)
    expect(passStrength('correct horse battery staple').score).toBe(3)
    expect(passStrength('short').label).toBe('Too short')
  }, 60_000)

  test('only well-formed sections survive the config sanitizer', () => {
    const sec: P2pSection = {
      v: 1,
      kdf: KDF,
      salt: b64u(new Uint8Array(16)),
      iv: b64u(new Uint8Array(12)),
      ct: 'AAAA',
    }
    const ok = sanitizeConfig({ v: 1, p2p: sec })
    expect(ok.ok && ok.doc.p2p).toEqual(sec)
    for (const bad of [
      { ...sec, v: 2 },
      { ...sec, extra: 1 },
      { ...sec, kdf: { ...KDF, alg: 'scrypt' } },
      { ...sec, kdf: { ...KDF, m: 1.5 } },
      { ...sec, salt: 'short' },
      { ...sec, iv: b64u(new Uint8Array(16)) },
      { ...sec, ct: 'not base64!' },
    ]) {
      const d = sanitizeConfig({ v: 1, p2p: bad })
      expect(d.ok && d.doc.p2p).toBeUndefined()
    }
  }, 60_000)
})

describe('dump and encryption', () => {
  test('every store but the excluded ones round-trips', async () => {
    const { a } = await scene({ server: true })
    const names = Array.from(a.store.db.objectStoreNames).filter(n => !EXCLUDED.has(n))
    const before = await readStores(a.store.db)
    // The scene must put something in every store, so a store added later without a test
    // fails here: add it to the scene.
    for (const n of names) expect([n, (before.get(n) ?? []).length > 0]).toEqual([n, true])
    const dump = await parseDump(await dumpBytes(a.store.db, 5))
    expect(dump.at).toBe(5)
    expect(dump.skipped).toBe(0)
    expect([...dump.stores.keys()].sort()).toEqual([...names].sort())
    for (const n of names)
      expect(dump.stores.get(n)?.map(r => r.value)).toEqual(before.get(n)?.map(r => r.value))
    // Raw keys survive as bytes.
    expect(dump.self.ik.sk instanceof Uint8Array).toBe(true)

    // And they all land in a new browser, next to what the move adds.
    const target = await fresh()
    const res = await applyImport(target.db, dump, 'new', { now: 1_700_000_100_000 })
    expect(res.kind).toBe('new')
    const after = await readStores(target.db)
    for (const n of names) {
      if (n === 'self' || n === 'rooms') continue
      // Server events come marked to be checked on the next start (server.ts load).
      const got = (after.get(n) ?? []).map(r => {
        const { imp: _i, ...v } = r.value as { imp?: true }
        return text(v)
      })
      for (const r of before.get(n) ?? []) expect(got).toContain(text(r.value))
    }
    // DMs and servers are counted apart (servers have a budget of their own).
    const meta = {
      events: (await target.db.get('meta', 'events')) as number,
      bytes: await target.db.get('meta', 'bytes'),
      server: (await target.db.get('meta', 'sevents')) as number,
    }
    expect(meta.events + meta.server).toBe((before.get('events') ?? []).length + 1)
    expect(meta.server).toBeGreaterThan(0)
    expect(meta.bytes).toBeGreaterThan(0)
    target.close()
  }, 60_000)

  // The `.rchat` file with files: the config text line, then the files, streamed.
  const rchatFile = async (db: P2pDatabase, text: string, fk: FilesKey) => {
    const parts: BlobPart[] = [`${text}\n`]
    let biggest = 0
    let pieces = 0
    await writeFiles(db, fk, async part => {
      biggest = Math.max(biggest, part.length)
      pieces += 1
      parts.push(new Blob([part as BlobPart]))
    })
    return { file: new Blob(parts), biggest, pieces }
  }

  const readBack = async (file: Blob) => {
    const split = await splitFile(file)
    if (!split) throw new Error('no first line')
    const head = await filesHead(split.rest)
    return { text: split.text, rest: split.rest, head }
  }

  test('files go only in the file, streamed after the data, and work on the new device', async () => {
    const { a } = await scene()
    const [rec] = await a.store.db.getAll('blobs')
    expect(await filesSize(a.store.db)).toBe(3000)
    // The dump itself never carries files.
    expect((await parseDump(await dumpBytes(a.store.db))).stores.has('blobs')).toBe(false)
    const { section, files } = await exportP2pWithFiles(a.store.db, PASS, KDF)
    const { file } = await rchatFile(a.store.db, 'rc1.config-text', files)
    const back = await readBack(file)
    expect(back.text).toBe('rc1.config-text')
    expect(back.head).toEqual({ id: files.id, salt: files.salt })
    const { dump, files: key } = await unlockP2pWithFiles(
      section,
      PASS,
      back.head as NonNullable<typeof back.head>
    )
    const target = await fresh()
    await applyImport(target.db, dump, 'new', { now: 1_700_000_100_000 })
    const res = await importFiles(target.db, back.rest, key)
    expect(res).toEqual({ files: 1, skipped: 0, complete: true })
    const got = await target.db.get('blobs', rec.h)
    expect(got?.done).toBe(true)
    expect(got?.hashed).toBe(true)
    // Checked and sniffed here, not taken from the file.
    expect(got?.type).toBe('application/octet-stream')
    expect(
      new Uint8Array(await ((await assemble(target.db, rec.h)) as Blob).arrayBuffer())
    ).toEqual(new Uint8Array(await (rec.file as Blob).arrayBuffer()))
    // Live messages still name the file, so the new device may serve it.
    expect(await target.db.countFromIndex('events', 'att', rec.h)).toBe(1)
    target.close()
    // The files of one export can't be read with another export's data.
    const other = await exportP2pWithFiles(a.store.db, PASS, KDF)
    expect(
      await unlockP2pWithFiles(
        other.section,
        PASS,
        back.head as NonNullable<typeof back.head>
      ).then(
        () => 'ok',
        (e: Error) => e.message
      )
    ).toBe(DAMAGED_DUMP)
  }, 60_000)

  test('a files part from a newer version: unknown frames and fields are passed over', async () => {
    const { a } = await scene()
    const { section, files } = await exportP2pWithFiles(a.store.db, PASS, KDF)
    const { file } = await rchatFile(a.store.db, 'rc1.x', files)
    const { head } = await readBack(file)
    const { dump, files: key } = await unlockP2pWithFiles(
      section,
      PASS,
      head as NonNullable<typeof head>
    )
    const data = new Uint8Array(2000).map((_, i) => (i * 13) % 256)
    const { h } = await hashBytes(data)
    const meta = { h, size: data.length, own: true, created: 1, lastUsed: 2, pinned: true }
    const enc = new TextEncoder()
    let n = 0
    const frame = (kind: number, body: Uint8Array, last = false) =>
      sealFilesFrame(files, n++, kind, body, last)
    const parts = [
      enc.encode(`${FILES_MAGIC}${JSON.stringify({ v: 1, id: files.id, salt: files.salt })}\n`),
      // A frame kind this version doesn't know, before and inside a file.
      await frame(9, enc.encode('{"thumbs":[]}')),
      await frame(F_FILE, enc.encode(JSON.stringify(meta))),
      await frame(9, new Uint8Array(3)),
      await frame(F_BLOCK, data),
      await frame(F_END, new Uint8Array(0), true),
    ]
    const t = await fresh()
    await applyImport(t.db, dump, 'new', { now: 1_700_000_100_000 })
    const res = await importFiles(t.db, new Blob(parts as BlobPart[]), key)
    expect(res).toEqual({ files: 1, skipped: 0, complete: true })
    const got = await t.db.get('blobs', h)
    expect(got?.done).toBe(true)
    expect(got && 'pinned' in got).toBe(false)
    t.close()
  }, 60_000)

  test('a damaged or cut files part keeps what checks out and drops the rest', async () => {
    const { a } = await scene()
    // A second file, two blocks long.
    const two = new Uint8Array(BLOCK + 500).map((_, i) => (i * 7) % 256)
    const hashed = await hashBytes(two)
    await a.dms.blobs.putOwn(new Blob([two as BlobPart]), hashed)
    const { section, files } = await exportP2pWithFiles(a.store.db, PASS, KDF)
    const { file } = await rchatFile(a.store.db, 'rc1.x', files)
    const { rest, head } = await readBack(file)
    const { dump, files: key } = await unlockP2pWithFiles(
      section,
      PASS,
      head as NonNullable<typeof head>
    )
    const bytes = new Uint8Array(await rest.arrayBuffer())
    const into = async (data: Uint8Array) => {
      const t = await fresh()
      await applyImport(t.db, dump, 'new', { now: 1_700_000_100_000 })
      const res = await importFiles(t.db, new Blob([data as BlobPart]), key)
      const parts = await t.db.count('blob_parts')
      const kept = (await t.db.getAll('blobs')).filter(r => r.done)
      const blocks = kept.reduce((x, r) => x + Math.ceil(r.size / BLOCK), 0)
      t.close()
      return { res, parts, done: kept.length, blocks }
    }
    expect((await into(bytes)).res).toEqual({ files: 2, skipped: 0, complete: true })
    // Cut short: files that came whole stay, a partial one leaves no blocks behind, and the cut
    // is reported.
    for (const end of [bytes.length - 2000, bytes.length - BLOCK / 2, 40]) {
      const cut = await into(bytes.subarray(0, end))
      expect(cut.res.complete).toBe(false)
      expect(cut.done).toBe(cut.res.files)
      expect(cut.parts).toBe(cut.blocks)
    }
    // A flipped byte: decryption stops there, and nothing after it is trusted.
    const flipped = bytes.slice()
    flipped[flipped.length - 100] ^= 1
    const bad = await into(flipped)
    expect(bad.res.complete).toBe(false)
    expect(bad.done).toBe(bad.res.files)
    expect(bad.parts).toBe(bad.blocks)
  }, 60_000)

  test('a large export streams one block at a time and has no size cap', async () => {
    const { a } = await scene()
    // 130 MiB (over the old 128 MiB cap) made of one repeated block, so the test stays fast.
    const block = new Uint8Array(BLOCK).map((_, i) => (i * 13) % 256)
    const n = 130
    const big = new Blob(Array.from({ length: n }, () => block as BlobPart))
    const one = b64u(new Uint8Array(await crypto.subtle.digest('SHA-256', block)))
    const blocks = Array.from({ length: n }, () => one)
    const h = blobRoot(n * BLOCK, blocks.map(fromB64u))
    await a.dms.blobs.putOwn(big, { h, size: n * BLOCK, blocks })
    expect(await filesSize(a.store.db)).toBe(n * BLOCK + 3000)
    const started = Date.now()
    const { section, files } = await exportP2pWithFiles(a.store.db, PASS, KDF)
    const { file, biggest, pieces } = await rchatFile(a.store.db, 'rc1.big', files)
    // Never more than one block (and its framing) at once.
    expect(biggest).toBeLessThanOrEqual(FILES_FRAME_MAX + 4)
    expect(pieces).toBeGreaterThan(n)
    const { rest, head } = await readBack(file)
    const { dump, files: key } = await unlockP2pWithFiles(
      section,
      PASS,
      head as NonNullable<typeof head>
    )
    const t = await fresh()
    await applyImport(t.db, dump, 'new', { now: 1_700_000_100_000 })
    let seen = 0
    const res = await importFiles(t.db, rest, key, d => {
      seen = d
    })
    expect(res).toEqual({ files: 2, skipped: 0, complete: true })
    expect(seen).toBe(n * BLOCK + 3000)
    expect((await t.db.get('blobs', h))?.done).toBe(true)
    expect(await t.db.count('blob_parts')).toBe(n + 1)
    t.close()
    expect(Date.now() - started).toBeLessThan(60_000)
  }, 120_000)

  test('summary of a dump', async () => {
    const { a } = await scene()
    const s = summarize(await parseDump(await dumpBytes(a.store.db)))
    expect(s).toMatchObject({ ik: a.node.ik, contacts: 1, rooms: 1, messages: 4 })
    expect(summaryText({ ...s, contacts: 12, rooms: 3, messages: 4210 })).toBe(
      `Identity ${s.fingerprint}, 12 contacts, 3 rooms, 4,210 messages`
    )
  }, 60_000)

  test('wrong passphrase and tampering fail cleanly', async () => {
    const { a } = await scene()
    const sec = await exportP2p(a.store.db, PASS, KDF)
    expect(sec.kdf).toEqual(KDF)
    const err = (p: Promise<unknown>) =>
      p.then(
        () => 'ok',
        (e: Error) => e.message
      )
    expect(await err(unlockP2p(sec, 'not the passphrase'))).toBe(WRONG_PASS)
    const ct = fromB64u(sec.ct)
    ct[ct.length >> 1] ^= 1
    expect(await err(unlockP2p({ ...sec, ct: b64u(ct) }, PASS))).toBe(WRONG_PASS)
    // The parameters and salt are bound as associated data.
    expect(await err(unlockP2p({ ...sec, kdf: { ...KDF, t: KDF.t + 1 } }, PASS))).toBe(WRONG_PASS)
    expect(await err(unlockP2p({ ...sec, salt: b64u(new Uint8Array(16)) }, PASS))).toBe(WRONG_PASS)
    // Crafted parameters are refused before any work.
    expect(await err(unlockP2p({ ...sec, kdf: { ...KDF, m: 19 * 1024 } }, PASS))).toBe(WEAK_KDF)
    expect(await err(unlockP2p({ ...sec, kdf: { ...KDF, t: 1 } }, PASS))).toBe(WEAK_KDF)
    expect(await err(unlockP2p({ ...sec, kdf: { ...KDF, m: 4 * 1024 * 1024 } }, PASS))).toBe(
      HEAVY_KDF
    )
    const dump = await unlockP2p(sec, PASS)
    expect(keyId(dump.self.ik.pk)).toBe(a.node.ik)
  }, 60_000)

  test('damaged dumps are refused', async () => {
    const pack = async (text: string) =>
      new Uint8Array(
        await new Response(
          new Blob([text]).stream().pipeThrough(new CompressionStream('deflate-raw'))
        ).arrayBuffer()
      )
    const msg = (p: Promise<unknown>) =>
      p.then(
        () => 'ok',
        (e: Error) => e.message
      )
    expect(await msg(parseDump(new Uint8Array([1, 2, 3])))).toBe(DAMAGED_DUMP)
    expect(await msg(parseDump(await pack('{"rchat":"p2p-dump","v":1,"schema":1,"at":1}\n')))).toBe(
      DAMAGED_DUMP
    )
    expect(
      await msg(parseDump(await pack('{"rchat":"p2p-dump","v":1,"schema":99,"at":1}\n')))
    ).toBe(NEWER_DUMP)
    const { a } = await scene()
    const real = await dumpBytes(a.store.db)
    expect(await msg(parseDump(real, 100))).toBe(DAMAGED_DUMP)
  }, 60_000)

  test('share links never carry the P2P section; the string and the file do', async () => {
    const { a } = await scene()
    const sec = await exportP2p(a.store.db, PASS, KDF)
    const all = new Set<SectionKey>(SECTIONS.map(s => s.key))
    const doc = {
      ...buildConfig(
        {
          theme: 'dark',
          streamer: false,
          appearOffline: false,
          layout: null,
          notify: EMPTY_NOTIFY,
          emoji: null,
          calls: null,
          typing: true,
          profanity: null,
          spoilers: null,
          relays: null,
        },
        all
      ),
      p2p: sec,
    }
    expect(linkDoc(doc).p2p).toBeUndefined()
    expect(SECTIONS.some(s => (s.key as string) === 'p2p')).toBe(false)
    const link = await encodeConfig(linkDoc(doc))
    const inflated = await new Response(
      new Blob([fromB64u(link.slice(PREFIX.length)) as BlobPart])
        .stream()
        .pipeThrough(new DecompressionStream('deflate-raw'))
    ).text()
    expect(Object.keys(JSON.parse(inflated) as object)).not.toContain('p2p')
    expect(inflated).not.toContain(sec.ct.slice(0, 32))
    expect(inflated).not.toContain(sec.salt)

    const full = await encodeConfig(doc)
    const linked = await decodeLink(full)
    expect(linked.ok && linked.doc.p2p).toBeUndefined()
    const asText = await decodeConfig(full)
    expect(asText.ok && asText.doc.p2p).toEqual(sec)
  }, 60_000)

  test('large strings need the file path', async () => {
    const big = `${PREFIX}${'A'.repeat(TEXT_MAX + 4)}`
    const pasted = await decodeConfig(big)
    expect(pasted.ok).toBe(false)
    const filed = await decodeConfig(big, Date.now(), FILE_LIMITS)
    // Not a real config either way, but the size check passed and decoding went on.
    expect(filed.ok).toBe(false)
    const doc = await encodeConfig({ v: 1, theme: 'dark' })
    expect((await decodeConfig(doc, Date.now(), FILE_LIMITS)).ok).toBe(true)
  }, 60_000)
})

describe('import cases', () => {
  test('a new browser gets a new device key, a revocation and move events', async () => {
    const { a, room } = await scene()
    const dump = await unlockP2p(await exportP2p(a.store.db, PASS, KDF), PASS)
    const target = await fresh()
    expect(importKind(await target.self(), dump)).toBe('new')
    const now = 1_700_000_500_000
    await applyImport(target.db, dump, 'new', { now })
    const self = await selfOf(target)
    const old = await selfOf(a.store)
    expect(keyId(self.ik.pk)).toBe(a.node.ik)
    expect(keyId(self.dk.pk)).not.toBe(keyId(old.dk.pk))
    expect(self.cert.dk).toBe(keyId(self.dk.pk))
    expect(self.certs[0]).toEqual(self.cert)
    expect(self.certs.some(c => c.dk === keyId(old.dk.pk))).toBe(false)
    const rev = self.revocations.at(-1)!
    expect(rev).toMatchObject({
      dk: keyId(old.dk.pk),
      successor: keyId(self.dk.pk),
      revoked_at: now,
    })
    expect(self.moved).toBeNull()
    // A move event on top of the heads, signed by the new device, waiting to be sent.
    const r = (await target.room(room))!
    const head = (await target.event(r.heads[0].id))!
    expect(head.type).toBe('move')
    expect(head.wire.ev.dev).toBe(keyId(self.dk.pk))
    const oldRoom = (await a.store.room(room))!
    expect(head.wire.ev.prev).toEqual(oldRoom.heads.map(h => h.id))
    expect((await target.outbox(room)).map(o => o.id)).toContain(head.id)
    // Unread state came along.
    expect(r.readSeq).toBe(oldRoom.readSeq)
    target.close()
  }, 60_000)

  test('the same identity merges: events dedupe, contacts merge, keys stay', async () => {
    const { a, b, room } = await scene()
    const first = await unlockP2p(await exportP2p(a.store.db, PASS, KDF), PASS)
    const x = await fresh()
    await applyImport(x.db, first, 'new')
    const xDk = keyId((await selfOf(x)).dk.pk)
    // Alice keeps going on the old browser.
    await b.node.setPaused(false)
    b.node.schedule(true)
    await eventually(async () => (await bodies(b, a.node.ik)).length === 3, 'catch up')
    await b.dms.send(room, { body: 'later from Bob' })
    await eventually(async () => (await bodies(a, b.node.ik)).length === 4, 'Bob later')
    await b.node.rename(a.node.ik, 'Al')
    await a.node.rename(b.node.ik, 'Bobby')
    const second: Dump = await unlockP2p(await exportP2p(a.store.db, PASS, KDF), PASS)
    expect(importKind(await x.self(), second)).toBe('merge')
    const before = (await x.db.getAll('events')).map(e => e.id)
    const res = await applyImport(x.db, second, 'merge')
    expect(res.kind).toBe('merge')
    const after = (await x.db.getAll('events')).map(e => e.id)
    const theirs = (await a.store.db.getAll('events')).map(e => e.id)
    expect(new Set(after).size).toBe(after.length)
    expect(new Set(after)).toEqual(new Set([...before, ...theirs]))
    expect(res.events).toBe(after.length - before.length)
    expect(await x.db.count('events')).toBe(after.length)
    expect(await x.db.get('meta', 'events')).toBe(after.length)
    // Merging the same file again adds nothing.
    const again = await applyImport(x.db, second, 'merge')
    expect(again.events).toBe(0)
    expect(await x.db.count('events')).toBe(after.length)
    // This browser keeps its own device key; the contact merged by identity.
    expect(keyId((await selfOf(x)).dk.pk)).toBe(xDk)
    const contacts = await x.contacts()
    expect(contacts.length).toBe(1)
    expect(contacts[0].petname).toBe('Bobby')
    const r = (await x.room(room))!
    expect(r.count).toBe(after.filter(id => id).length)
    const msgs = (await loadMessages(x.db, room, a.node.ik, b.node.ik, { limit: 100 })).messages
    expect(msgs.map(m => m.body)).toContain('later from Bob')
    x.close()
  }, 60_000)

  test('another identity is replaced; a failing import changes nothing', async () => {
    const { a } = await scene()
    const dump = await unlockP2p(await exportP2p(a.store.db, PASS, KDF), PASS)
    const clock = new ManualClock()
    const hub = new Hub()
    const carol = await makePeer(hub, 'Carol', clock)
    const dave = await makePeer(hub, 'Dave', clock)
    await friends(carol, dave)
    carol.dms.stop()
    carol.node.stop()
    const db = carol.store.db
    expect(importKind(await carol.store.self(), dump)).toBe('replace')
    // The kind no longer matches what is stored: refused, nothing written.
    expect(
      await applyImport(db, dump, 'new').then(
        () => 'ok',
        (e: Error) => e.message
      )
    ).toBe(CHANGED)
    // A record that can't be stored aborts the whole transaction.
    const broken: Dump = {
      ...dump,
      stores: new Map([...dump.stores, ['children', [{ value: { parent: 'x' } }]]]),
    }
    expect(
      await applyImport(db, broken, 'replace').then(
        () => 'ok',
        () => 'failed'
      )
    ).toBe('failed')
    expect(keyId((await selfOf(carol.store)).ik.pk)).toBe(carol.node.ik)
    expect((await carol.store.contacts()).map(c => c.ik)).toEqual([dave.node.ik])
    await applyImport(db, dump, 'replace')
    expect(keyId((await selfOf(carol.store)).ik.pk)).toBe(a.node.ik)
    expect((await carol.store.contacts()).map(c => c.ik)).not.toContain(dave.node.ik)
  }, 60_000)
})

describe('after the move', () => {
  test('contacts see the move, keep history, and refuse the old device', async () => {
    const { clock, hub, a, b, room } = await scene()
    // Alice exports and stops the old browser; the message Bob missed is still in its outbox.
    const sec = await exportP2p(a.store.db, PASS, KDF)
    await a.node.markExported(clock.now())
    a.dms.stop()
    a.node.stop()
    const dump = await unlockP2p(sec, PASS)
    const name = `test-move-new-${Math.random()}`
    const store = await P2pStore.open(name)
    await applyImport(store.db, dump, 'new', { now: clock.now() })
    store.close()
    const a2 = await openPeer(hub, name, clock)
    await a2.dms.recheckOutbox()
    await a2.node.start()
    await b.node.setPaused(false)
    a2.node.schedule(true)
    await waitFor(() => b.node.contact(a.node.ik)?.notice?.kind === 'moved', 'move notice', SLOW)
    const moved = b.node.contact(a.node.ik)!
    expect(moved.revocations.some(r => r.dk === a.node.dk)).toBe(true)
    // The message the old device signed before the move arrives, vouched for by the new device.
    await eventually(
      async () => (await bodies(b, a.node.ik)).includes('sent while Bob was away'),
      'pre-move message',
      SLOW
    )
    expect(await bodies(b, a.node.ik)).toEqual([
      'hello there Bob',
      'hi Alice',
      'a file',
      'sent while Bob was away',
    ])
    // Bob writes to the new device; it answers.
    await waitFor(() => linked(a2, b), 'new link', SLOW)
    await b.dms.send(room, { body: 'welcome back' })
    await eventually(
      async () => (await bodies(a2, b.node.ik)).includes('welcome back'),
      'to A2',
      SLOW
    )
    await a2.dms.send(room, { body: 'from the new device' })
    await eventually(
      async () => (await bodies(b, a.node.ik)).includes('from the new device'),
      'from A2',
      SLOW
    )

    // An event the old key signs after the revocation is refused; one from before is valid.
    const oldSelf = await selfOf(a.store)
    const rev = moved.revocations.find(r => r.dk === a.node.dk)!
    const auth = {
      room,
      members: [a.node.ik, b.node.ik],
      devices: (ik: string) => b.node.devicesOf(ik),
    }
    const author = { ik: oldSelf.ik, dk: oldSelf.dk }
    const late = buildEvent(author, room, 'msg', { body: 'late' }, [], 0, rev.revoked_at + 1)
    expect(validate(late.wire, auth)).toEqual({ ok: false, why: 'revoked' })
    const early = buildEvent(author, room, 'msg', { body: 'early' }, [], 0, rev.revoked_at - 1)
    expect(validate(early.wire, auth)).toMatchObject({ ok: true, revoked: true })

    // The old browser comes back: Bob tells it, and it stops for good.
    await a.node.start()
    a.node.schedule(true)
    await waitFor(() => a.node.status === 'moved', 'old device told', SLOW)
    expect(a.node.author()).toBeNull()
    expect(a.node.view().movedAt).toBe(rev.revoked_at)
    expect((await selfOf(a.store)).moved).toEqual({ at: rev.revoked_at, successor: a2.node.dk })
    // It exported for this move, so nothing is alarming; its secrets are gone, the public halves
    // and the history stay.
    expect(a.node.view().alertAt).toBeNull()
    const gone = await selfOf(a.store)
    expect([gone.ik.sk.length, gone.dk.sk.length]).toEqual([0, 0])
    expect(keyId(gone.ik.pk)).toBe(a.node.ik)
    expect(keyId(gone.dk.pk)).toBe(a.node.dk)
    expect((await bodies(a, b.node.ik)).length).toBeGreaterThan(0)
    // Nothing can be exported from it any more.
    expect(
      await exportP2p(a.store.db, PASS, KDF).then(
        () => 'exported',
        (e: Error) => e.message
      )
    ).toBe(MOVED_EXPORT)
    const oldDms = new Dms({ node: a.node, store: a.store, clock })
    live.push({ node: a.node, store: a.store, dms: oldDms, db: a.db })
    expect(
      await oldDms.send(room, { body: 'still here?' }).then(
        () => 'sent',
        (e: Error) => e.message
      )
    ).toBe(MOVED_TEXT)
    expect(await bodies(b, a.node.ik)).not.toContain('still here?')
    // A moved node stays down when started again.
    a.node.stop()
    await a.node.start()
    expect(a.node.status).toBe('moved')
  }, 120_000)
})

// Rewrites the JSON lines of a dump (the header stays), at the level of the tagged JSON.
const rewrite = async (bytes: Uint8Array, fn: (line: unknown[]) => unknown[] | null) => {
  const text = await new Response(
    new Blob([bytes as BlobPart]).stream().pipeThrough(new DecompressionStream('deflate-raw'))
  ).text()
  const [head, ...lines] = text.split('\n').filter(Boolean)
  const out = [head]
  for (const l of lines) {
    const next = fn(JSON.parse(l) as unknown[])
    if (next) out.push(JSON.stringify(next))
  }
  return new Uint8Array(
    await new Response(
      new Blob([`${out.join('\n')}\n`]).stream().pipeThrough(new CompressionStream('deflate-raw'))
    ).arrayBuffer()
  )
}

const failure = (p: Promise<unknown>) =>
  p.then(
    () => 'ok',
    (e: Error) => e.message
  )

// Review round 1: a moved browser keeps no secret and makes no files; one file makes at most
// one device here; an export pauses sending; and the limits of a move (every device holds the
// identity key) are visible to the user.
describe('moving safely', () => {
  test('files from a moved browser are refused, and old moved records lose their secrets', async () => {
    const { a, b, hub, clock } = await scene()
    const bytes = await dumpBytes(a.store.db)
    const moved = await rewrite(bytes, l =>
      l[0] === 'self'
        ? ['self', { ...(l[1] as object), moved: { at: 1, successor: b.node.dk } }]
        : l
    )
    expect(await failure(parseDump(moved))).toBe(MOVED_DUMP)
    // A record moved before secrets were dropped: opening it drops them.
    a.dms.stop()
    a.node.stop()
    await a.store.updateSelf(cur => ({ ...cur!, moved: { at: 1, successor: b.node.dk } }))
    expect((await selfOf(a.store)).ik.sk.length).toBe(32)
    const again = await openPeer(hub, a.db, clock)
    expect(again.node.author()).toBeNull()
    expect((await selfOf(a.store)).ik.sk.length).toBe(0)
    expect(await failure(dumpBytes(a.store.db))).toBe(MOVED_EXPORT)
    expect(withoutSecrets(await selfOf(a.store)).dk.pk.length).toBe(32)
  }, 60_000)

  test('the same file never makes a second device in a browser that has it', async () => {
    const { a } = await scene()
    const dump = await unlockP2p(await exportP2p(a.store.db, PASS, KDF), PASS)
    const x = await fresh()
    await applyImport(x.db, dump, 'new')
    const first = await selfOf(x)
    expect(first.imports).toEqual([dump.id])
    // The second time it is a merge that changes nothing.
    expect(importKind(first, dump)).toBe('merge')
    expect(alreadyImported(first, dump)).toBe(true)
    const events = await x.db.count('events')
    const res = await applyImport(x.db, dump, 'merge')
    expect(res).toEqual({ kind: 'merge', contacts: 0, rooms: 0, events: 0, skipped: 0 })
    expect(await selfOf(x)).toEqual(first)
    expect(await x.db.count('events')).toBe(events)
    // Each export has its own id; the browser remembers ids even past removing its P2P data.
    const other = await unlockP2p(await exportP2p(a.store.db, PASS, KDF), PASS)
    expect(other.id).not.toBe(dump.id)
    expect(alreadyImported(first, other)).toBe(false)
    expect(parseImports(JSON.stringify({ v: 1, ids: [dump.id, 5] }))).toEqual([dump.id])
    expect(parseImports('nope')).toEqual([])
    x.close()
  }, 60_000)

  test('merging a file from the new device retires this one', async () => {
    const { a } = await scene()
    const dump = await unlockP2p(await exportP2p(a.store.db, PASS, KDF), PASS)
    const x = await fresh()
    await applyImport(x.db, dump, 'new')
    const back = await unlockP2p(await exportP2p(x.db, PASS, KDF), PASS)
    a.dms.stop()
    a.node.stop()
    await applyImport(a.store.db, back, 'merge')
    const self = await selfOf(a.store)
    expect(self.moved).toMatchObject({ successor: keyId((await selfOf(x)).dk.pk) })
    expect([self.ik.sk.length, self.dk.sk.length]).toEqual([0, 0])
    expect(await failure(exportP2p(a.store.db, PASS, KDF))).toBe(MOVED_EXPORT)
    x.close()
  }, 60_000)

  test('crafted rows: bad heads, unsigned devices and tag look-alikes', async () => {
    const { a, b } = await scene()
    const stranger = newKeyPair()
    const bytes = await rewrite(await dumpBytes(a.store.db), l => {
      if (l[0] === 'rooms') {
        const r = l[1] as { heads: unknown[] }
        return ['rooms', { ...r, heads: [...r.heads, { id: 'x', depth: 'deep' }] }]
      }
      if (l[0] === 'contacts') {
        const c = l[1] as { certs: unknown[] }
        const fake = signCert(stranger, newKeyPair().pk, 1, 'fake')
        return [
          'contacts',
          {
            ...c,
            certs: [...c.certs, JSON.parse(JSON.stringify(fake))],
            note: { $$b: 'AAAA', $$blob: 'x', type: 't', $$$deep: 1 },
          },
        ]
      }
      return l
    })
    const dump = await parseDump(bytes)
    expect(dump.stores.get('rooms')).toEqual([])
    expect(dump.skipped).toBe(1)
    const c = dump.stores.get('contacts')![0].value as Contact & { note: unknown }
    expect(c.certs.length).toBeGreaterThan(0)
    expect(c.certs.some(x => x.label === 'fake')).toBe(false)
    expect(c.certs.every(x => x.ik === b.node.ik)).toBe(true)
    // User data that looks like a tag comes back as it was.
    expect(c.note).toEqual({ $b: 'AAAA', $blob: 'x', type: 't', $$deep: 1 })
    // And an object stored with such keys round-trips.
    await a.store.updateContact(b.node.ik, cur => ({
      ...cur!,
      petname: 'Bo',
      ...({ extra: { $b: 'AAAA' } } as object),
    }))
    const round = await parseDump(await dumpBytes(a.store.db))
    expect((round.stores.get('contacts')![0].value as { extra: unknown }).extra).toEqual({
      $b: 'AAAA',
    })
  }, 60_000)

  test('after an export, sending pauses here until resumed; receiving goes on', async () => {
    const { a, b, room, clock } = await scene()
    await b.node.setPaused(false)
    b.node.schedule(true)
    await eventually(async () => (await bodies(b, a.node.ik)).length === 3, 'catch up')
    const [first] = (await loadMessages(a.store.db, room, a.node.ik, b.node.ik, { limit: 10 }))
      .messages
    // Another tab made the export: the stored record is what counts.
    await a.store.updateSelf(cur => ({ ...cur!, moving: { at: clock.now() }, exported: 1 }))
    expect(await failure(a.dms.send(room, { body: 'paused?' }))).toBe(MOVING_TEXT)
    expect(a.node.view().movingAt).toBe(clock.now())
    await a.node.resumeSending()
    await a.dms.send(room, { body: 'resumed' })
    await eventually(async () => (await bodies(b, a.node.ik)).includes('resumed'), 'resumed')

    await exportP2p(a.store.db, PASS, KDF)
    await a.node.markExported(clock.now())
    for (const act of [
      () => a.dms.send(room, { body: 'no' }),
      () => a.dms.edit(room, first.id, 'no'),
      () => a.dms.react(room, first.id, '👍', false),
      () => a.dms.pin(room, first.id, false),
      () => a.dms.redact(room, first.id),
    ])
      expect(await failure(act())).toBe(MOVING_TEXT)
    await b.dms.send(room, { body: 'still reaches you' })
    await eventually(async () => (await bodies(a, b.node.ik)).includes('still reaches you'), 'in')
    expect(await bodies(b, a.node.ik)).not.toContain('no')
  }, 60_000)

  test('what arrives after the export still reaches the new device', async () => {
    const { a, b, room, clock, hub } = await scene()
    await b.node.setPaused(false)
    b.node.schedule(true)
    await eventually(async () => (await bodies(b, a.node.ik)).length === 3, 'catch up')
    const dump = await unlockP2p(await exportP2p(a.store.db, PASS, KDF), PASS)
    await a.node.markExported(clock.now())
    await b.dms.send(room, { body: 'after the export' })
    await eventually(async () => (await bodies(a, b.node.ik)).includes('after the export'), 'old')
    a.dms.stop()
    a.node.stop()
    // The new device has the same keys: it dials only once Bob saw the old one go, or Bob may
    // still hold that session and the dial would back off on a clock that doesn't move.
    await waitFor(() => b.node.presence(a.node.ik) === 'offline', 'the old device gone')
    const name = `test-move-late-${Math.random()}`
    const store = await P2pStore.open(name)
    await applyImport(store.db, dump, 'new', { now: clock.now() })
    store.close()
    const a2 = await openPeer(hub, name, clock)
    await a2.node.start()
    await eventually(async () => {
      a2.node.schedule(true)
      return (await bodies(a2, b.node.ik)).includes('after the export')
    }, 'synced to the new device')
  }, 60_000)

  test('limit: anyone with the identity key can move the live device away; it raises the alert', async () => {
    const { a, b, room, clock, hub } = await scene()
    // The user moves to X.
    const dump = await unlockP2p(await exportP2p(a.store.db, PASS, KDF), PASS)
    await a.node.markExported(clock.now())
    a.dms.stop()
    a.node.stop()
    const xName = `test-move-x-${Math.random()}`
    let st = await P2pStore.open(xName)
    await applyImport(st.db, dump, 'new', { now: clock.now() })
    st.close()
    const x = await openPeer(hub, xName, clock)
    await x.node.start()
    await b.node.setPaused(false)
    x.node.schedule(true)
    await waitFor(() => linked(x, b), 'X linked')
    expect(x.node.view().alertAt).toBeNull()

    // A thief with a copy of the key (a stolen device or file) revokes X in favour of T.
    clock.advance(1000)
    const tName = `test-move-t-${Math.random()}`
    st = await P2pStore.open(tName)
    await applyImport(st.db, dump, 'new', { now: clock.now() })
    await st.updateSelf(cur => ({
      ...cur!,
      revocations: [
        ...cur!.revocations,
        signRevocation(cur!.ik, x.node.dk, clock.now(), keyId(cur!.dk.pk)),
      ],
    }))
    st.close()
    const t = await openPeer(hub, tName, clock)
    await t.node.start()
    t.node.schedule(true)
    await waitFor(
      () => !!b.node.contact(a.node.ik)?.revocations.some(r => r.dk === x.node.dk),
      'X revoked at Bob'
    )
    x.node.schedule(true)
    await waitFor(() => x.node.status === 'moved', 'X moved away')
    // X never exported: the user is told and pointed to a reset.
    expect(x.node.view().alertAt).not.toBeNull()
    const xs = await selfOf(x.store)
    expect([xs.ik.sk.length, xs.dk.sk.length]).toEqual([0, 0])
    expect(await failure(x.dms.send(room, { body: 'mine' }))).toBe(MOVED_TEXT)
    // A reset here starts a new identity the thief doesn't hold.
    await x.node.resetIdentity()
    expect(x.node.ik).not.toBe(a.node.ik)
    expect(x.node.view()).toMatchObject({ movedAt: null, alertAt: null })
    expect((await selfOf(x.store)).succession).toBeNull()
  }, 60_000)

  test('two devices from one file: each is told another one uses the identity', async () => {
    const { a, b, clock, hub } = await scene()
    const dump = await unlockP2p(await exportP2p(a.store.db, PASS, KDF), PASS)
    a.dms.stop()
    a.node.stop()
    const open = async (tag: string) => {
      const name = `test-move-${tag}-${Math.random()}`
      const st = await P2pStore.open(name)
      await applyImport(st.db, dump, 'new', { now: clock.now() })
      st.close()
      return openPeer(hub, name, clock)
    }
    const x = await open('x')
    const y = await open('y')
    await b.node.setPaused(false)
    await x.node.start()
    x.node.schedule(true)
    await waitFor(() => linked(x, b), 'X linked')
    await y.node.start()
    y.node.schedule(true)
    await waitFor(() => x.node.view().alertAt !== null, 'X alerted')
    await waitFor(() => {
      if (y.node.view().alertAt === null) y.node.schedule(true)
      return y.node.view().alertAt !== null
    }, 'Y alerted')
    // Bob kept both revocations of the old device as evidence.
    const revs = b.node.contact(a.node.ik)!.revocations.filter(r => r.dk === a.node.dk)
    expect(new Set(revs.map(r => r.successor))).toEqual(new Set([x.node.dk, y.node.dk]))
  }, 60_000)

  test('identityConflict', () => {
    const ik = newKeyPair()
    const ikId = keyId(ik.pk)
    const [d1, d2, d3] = [newKeyPair(), newKeyPair(), newKeyPair()]
    const id = (k: { pk: Uint8Array }) => keyId(k.pk)
    const cert = (k: { pk: Uint8Array }, at: number) => signCert(ik, k.pk, at, 'Browser')
    const self = {
      ik,
      dk: d2,
      cert: cert(d2, 2),
      revocations: [signRevocation(ik, id(d1), 2, id(d2))],
    } as unknown as SelfRecord
    expect(ikId.length).toBeGreaterThan(0)
    // A single line of moves: fine.
    expect(identityConflict(self, [cert(d2, 2), cert(d1, 1)], self.revocations)).toBe(false)
    // Another live device.
    expect(identityConflict(self, [cert(d3, 3)], [])).toBe(true)
    // The old device moved twice.
    expect(identityConflict(self, [], [signRevocation(ik, id(d1), 3, id(d3))])).toBe(true)
    // A moved-away device that is no longer live is fine.
    expect(identityConflict(self, [cert(d3, 3)], [signRevocation(ik, id(d3), 4, id(d2))])).toBe(
      false
    )
  })
})

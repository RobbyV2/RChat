import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import Peer from 'peerjs'
import { home } from '../instances'
import {
  ACK_WINDOW,
  ASKS_PER_MIN,
  base64ToBlob,
  CANCELED,
  canHookOffers,
  CHUNK_BYTES,
  HELD_OFFERS_MAX,
  HELD_PER_PEER,
  HOSTED_MAX,
  hostingMsg,
  intentOf,
  expiryDelay,
  keepPreview,
  LEGACY_MAX,
  MISMATCH,
  NO_ROOM,
  P2pManager,
  PEER_SERVE_MAX,
  PENDING_MAX,
  previewUrl,
  REFUSED,
  REFUSED_RELAY,
  SERVE_MAX,
  serveDeadline,
  servable,
  SLOW_STORE,
  type DownloadOpts,
  type StoredFile,
  unexpired,
} from '../p2p'
import { setBlobs, type BlobStore } from '../platform'
import { DENIED_DOWNLOAD, PROMPTS, relayBook, type Decision } from '../relays'
import { webBlobs } from '../platform/web_blobs'
import { Sha256 } from '../sha256'
import { NEUTRAL_TYPE } from '../sniff'

const file = (expires_at: number | null): StoredFile => ({
  name: 'a.txt',
  mime: 'text/plain',
  size: 1,
  data: 'YQ==',
  expires_at,
})

describe('p2p expiry timer', () => {
  test('waits until the expiry second, never for indefinite or past files', () => {
    expect(expiryDelay(null, 0)).toBeNull()
    expect(expiryDelay(100, 100_000)).toBeNull()
    expect(expiryDelay(100, 101_000)).toBeNull()
    expect(expiryDelay(100, 99_500)).toBe(500)
    expect(expiryDelay(1e12, 0)).toBe(2 ** 31 - 1)
  })
})

describe('p2p serving', () => {
  test('never serves missing or expired files', () => {
    expect(servable(null, 100)).toBeNull()
    expect(servable(file(100), 100)).toBeNull()
    expect(servable(file(101), 100)?.name).toBe('a.txt')
    expect(servable(file(null), 100)?.name).toBe('a.txt')
  })

  test('a file is offered for download only until it expires', () => {
    expect(unexpired(null, 100)).toBe(true)
    expect(unexpired(101, 100)).toBe(true)
    expect(unexpired(100, 100)).toBe(false)
  })
})

describe('p2p storage failures', () => {
  const g = globalThis as { localStorage?: unknown }
  const real = g.localStorage
  const realWarn = console.warn
  afterEach(() => {
    g.localStorage = real
    console.warn = realWarn
  })

  const account = (m: P2pManager, name = 'alice') => {
    ;(m as unknown as { announce: () => void }).announce = () => {}
    m.setAccount(name)
    return m
  }

  test('the peer id stays the same when storage is unavailable', () => {
    console.warn = () => {}
    g.localStorage = {
      getItem: () => {
        throw new Error('denied')
      },
      setItem: () => {
        throw new Error('denied')
      },
      removeItem: () => {},
    }
    const m = account(new P2pManager())
    const id = m.peerId()
    expect(/^[0-9a-f]+$/.test(id)).toBe(true)
    expect(m.peerId()).toBe(id)
  })

  test('peer ids are new each session, never stored, and a taken one is replaced', () => {
    const local = new Map<string, string>([['rchat_peer_id:alice', 'abc']])
    g.localStorage = {
      getItem: (k: string) => local.get(k) ?? null,
      setItem: (k: string, v: string) => void local.set(k, v),
      removeItem: (k: string) => void local.delete(k),
    }
    const m = account(new P2pManager())
    const x = m as unknown as { taken: (peer: unknown) => void; announce: () => void }
    let announced = 0
    x.announce = () => {
      announced += 1
    }
    const first = m.peerId()
    expect(/^[0-9a-f]{32}$/.test(first)).toBe(true)
    expect(local.has('rchat_peer_id:alice')).toBe(false)
    let destroyed = false
    x.taken({
      destroy: () => {
        destroyed = true
      },
    })
    const fresh = m.peerId()
    expect(/^[0-9a-f]{32}$/.test(fresh) && fresh !== first).toBe(true)
    expect([destroyed, announced, local.size]).toEqual([true, 1, 0])
    expect(m.peerId()).toBe(fresh)
  })

  test('removing and expiring files never throws when storage writes fail', () => {
    const m = account(new P2pManager())
    const x = m as unknown as { cached: unknown; announce: () => void }
    x.cached = { old: file(1), kept: file(null), gone: file(null) }
    console.warn = () => {}
    g.localStorage = {
      getItem: () => null,
      setItem: () => {
        throw new Error('full')
      },
      removeItem: () => {},
    }
    let announced = 0
    x.announce = () => {
      announced += 1
    }
    m.purgeExpired()
    m.removeFile('gone')
    expect(Object.keys(m.files())).toEqual(['kept'])
    expect(announced).toBe(2)
  })
})

type Handler = (arg?: unknown) => void
type Handler2 = (event: string, arg?: unknown) => void

function pipe(peer = 'remote') {
  const make = () => {
    const on = new Map<string, Handler>()
    return {
      open: true,
      peer,
      bufferSize: 0,
      other: null as null | { emit: (e: string, a?: unknown) => void },
      on(event: string, cb: Handler) {
        on.set(event, cb)
      },
      emit(event: string, arg?: unknown) {
        on.get(event)?.(arg)
      },
      async send(msg: unknown) {
        await Promise.resolve()
        this.other?.emit('data', structuredClone(msg))
      },
      close() {
        if (!this.open) return
        this.open = false
        this.emit('close')
      },
    }
  }
  const client = make()
  const host = make()
  client.other = host
  host.other = client
  return { client, host }
}

// Download tokens as the server makes them (src/p2p.rs), signed with the hoster's key.
const KEY = new Uint8Array(32).fill(7)
const KEY_HEX = '07'.repeat(32)
const b64url = (b: Uint8Array) =>
  btoa(String.fromCharCode(...b))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')
const mint = async (grant: object, key: Uint8Array<ArrayBuffer> = KEY) => {
  const payload = b64url(new TextEncoder().encode(JSON.stringify(grant)))
  const k = await crypto.subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, [
    'sign',
  ])
  const sig = await crypto.subtle.sign('HMAC', k, new TextEncoder().encode(payload))
  return `${payload}.${b64url(new Uint8Array(sig))}`
}
const nowS = () => Math.floor(Date.now() / 1000)
// A token from `r` at peer `rp` for file `f` of the hoster `host`.
const tokenFor = (host: P2pManager, f: string, rp: string, r = 'viewer', over: object = {}) =>
  mint({
    v: 1,
    m: 7,
    f,
    r,
    h: (host as unknown as { user: string }).user,
    hp: host.peerId(),
    rp,
    exp: nowS() + 60,
    ...over,
  })

const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
const SVG = new TextEncoder().encode(
  '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'
)

describe('p2p transfer', () => {
  const g = globalThis as { localStorage?: unknown }
  const real = g.localStorage
  const kept = new Map<string, Blob>()
  let room: number | null = null
  let failWrites = false
  let stallWrites = false
  let finishGate: Promise<void> | null = null
  let log: string[] = []
  const store: BlobStore = {
    put: async (k, b) => {
      kept.set(k, b)
    },
    get: async k => kept.get(k) ?? null,
    remove: async k => {
      kept.delete(k)
    },
    create: async key => {
      let parts: Uint8Array[] = []
      return {
        write: async chunk => {
          if (failWrites) throw new Error('QuotaExceededError')
          if (stallWrites) await new Promise(() => {})
          parts.push(chunk)
        },
        finish: async type => {
          log.push('finish')
          if (finishGate) await finishGate
          const blob = new Blob(parts as BlobPart[], { type })
          kept.set(key, blob)
          log.push('finished')
          return blob
        },
        abort: async () => {
          log.push('abort')
          parts = []
        },
      }
    },
    clear: async prefix => {
      for (const k of [...kept.keys()]) if (k.startsWith(prefix)) kept.delete(k)
    },
    room: async () => room,
  }
  type Wire = {
    serve: (conn: unknown) => void
    ensurePeer: () => unknown
    announce: () => void
    wire: (peer: unknown) => void
    heldMs: number
  }
  const manager = (name = 'host') => {
    const m = new P2pManager()
    const x = m as unknown as Wire
    x.announce = () => {}
    m.setAccount(name)
    m.setServeKey(KEY_HEX, m.peerId(), null)
    return { m, x }
  }
  // Asks `host` for a file on the connection `side`, with a token for that connection's peer.
  const ask = async (
    host: Wire,
    side: { peer: string; emit: Handler2 },
    msg: object,
    r?: string
  ) => {
    const id = (msg as { id: string }).id
    const token = await tokenFor(host as unknown as P2pManager, id, side.peer, r ?? side.peer)
    side.emit('data', { type: 'get', ...msg, token })
  }
  const bytes = (n: number, head: number[] = []) => {
    const out = new Uint8Array(n)
    for (let i = 0; i < n; i += 1) out[i] = (i * 31) % 251
    out.set(head.slice(0, n))
    return out
  }
  const hex = (b: Uint8Array) => new Sha256().update(b).hex()
  const fetchFrom = (
    host: Wire,
    id: string,
    opts: Partial<DownloadOpts> = {},
    sent?: unknown[],
    peer = 'remote',
    meta?: unknown
  ) => {
    const { client, host: side } = pipe(peer)
    const { m, x } = manager('viewer')
    const connects: unknown[] = []
    x.ensurePeer = () => ({
      connect: (_to: string, o: unknown) => {
        connects.push(o)
        return client
      },
    })
    if (meta !== undefined) (side as { metadata?: unknown }).metadata = meta
    if (sent) {
      const send = side.send.bind(side)
      side.send = async (msg: unknown) => {
        sent.push(msg)
        await send(msg)
      }
    }
    host.serve(side)
    const got = tokenFor(host as unknown as P2pManager, id, peer).then(token => {
      const out = m.download('host', id, {
        size: null,
        sha256: null,
        hoster: 'host',
        token,
        ...opts,
      })
      setTimeout(() => client.emit('open'), 0)
      return out
    })
    return { got, m, connects }
  }

  beforeEach(() => {
    const local = new Map<string, string>()
    g.localStorage = {
      getItem: (k: string) => local.get(k) ?? null,
      setItem: (k: string, v: string) => void local.set(k, v),
      removeItem: (k: string) => void local.delete(k),
    }
    kept.clear()
    room = null
    failWrites = false
    stallWrites = false
    finishGate = null
    log = []
    setBlobs(store)
  })
  afterEach(() => {
    g.localStorage = real
    setBlobs(webBlobs)
  })

  test('large files stream in chunks into the store and are checked against the hash', async () => {
    const { m, x } = manager()
    const size = CHUNK_BYTES * 3 + 17
    const data = bytes(size, PNG)
    await m.storeFile('big', new File([data], 'big.png', { type: 'text/html' }), null, hex(data))
    expect(kept.get('h:host:big')?.size).toBe(size)
    expect((localStorage.getItem('rchat_p2p_files:host')?.length ?? 0) < 300).toBe(true)
    const sent: unknown[] = []
    const progress: number[] = []
    const { got, m: viewer } = fetchFrom(
      x,
      'big',
      { size, sha256: hex(data), messageId: 7, onProgress: n => progress.push(n) },
      sent
    )
    const out = await got
    expect(sent.map(s => (s as { type: string }).type)).toEqual([
      'meta',
      'chunk',
      'chunk',
      'chunk',
      'chunk',
      'end',
    ])
    expect((sent[0] as { mime: string }).mime).toBe('image/png')
    expect([out.type, out.blob.type, out.verified]).toEqual(['image/png', 'image/png', true])
    expect(new Uint8Array(await out.blob.arrayBuffer())).toEqual(data)
    expect(progress.at(-1)).toBe(size)
    const copy = `d:viewer:big:${hex(data)}:host`
    expect(kept.get(copy)?.size).toBe(size)
    expect(viewer.received()[`big:${hex(data)}:host`]?.message_id).toBe(7)
    viewer.forgetMessage(7)
    await Promise.resolve()
    expect(kept.has(copy)).toBe(false)
    m.removeFile('big')
    await Promise.resolve()
    expect(kept.has('h:host:big')).toBe(false)
    const gone = await fetchFrom(x, 'big').got.catch((e: unknown) => e)
    expect(gone instanceof Error ? gone.message : null).toBe('File not available')
  })

  test('a hostile type stays inert: SVG or HTML bytes come out as application/octet-stream', async () => {
    const { m, x } = manager()
    await m.storeFile('svg', new File([SVG], 'cat.png', { type: 'image/svg+xml' }), null, hex(SVG))
    const sent: unknown[] = []
    const out = await fetchFrom(x, 'svg', { size: SVG.length, sha256: hex(SVG) }, sent).got
    expect((sent[0] as { mime: string }).mime).toBe(NEUTRAL_TYPE)
    expect(out.type).toBe(NEUTRAL_TYPE)
    expect(out.blob.type).toBe(NEUTRAL_TYPE)

    const { client } = pipe()
    const { m: viewer, x: vx } = manager('viewer')
    vx.ensurePeer = () => ({ connect: () => client })
    const got = viewer.download('host', 'f', { size: SVG.length, sha256: null, hoster: 'host' })
    await new Promise(r => setTimeout(r, 0))
    client.emit('open')
    client.emit('data', { type: 'meta', id: 'f', mime: 'text/html', size: SVG.length })
    client.emit('data', { type: 'chunk', id: 'f', data: SVG })
    client.emit('data', { type: 'end', id: 'f' })
    const evil = await got
    expect([evil.type, evil.blob.type, evil.verified]).toEqual([NEUTRAL_TYPE, NEUTRAL_TYPE, false])
  })

  test('a hash mismatch discards the download', async () => {
    const { m, x } = manager()
    const data = bytes(1000, PNG)
    await m.storeFile('f', new File([data], 'f.png'), null)
    const { got, m: viewer } = fetchFrom(x, 'f', { size: 1000, sha256: 'ab'.repeat(32) })
    const e = await got.catch((err: unknown) => err)
    expect(e instanceof Error ? e.message : null).toBe(MISMATCH)
    await new Promise(r => setTimeout(r, 0))
    expect([...kept.keys()].filter(k => k.startsWith('d:'))).toEqual([])
    expect(viewer.received()).toEqual({})
  })

  test('downloads stop at the declared size, at the storage quota, and on cancel', async () => {
    const { m, x } = manager()
    const data = bytes(CHUNK_BYTES * 2)
    await m.storeFile('f', new File([data], 'f.bin'), null)
    const wrong = await fetchFrom(x, 'f', { size: 10 }).got.catch((e: unknown) => e)
    expect(wrong instanceof Error ? wrong.message : null).toBe(
      'P2P download failed: file too large'
    )
    room = 100
    const full = await fetchFrom(x, 'f', { size: data.length }).got.catch((e: unknown) => e)
    expect(full instanceof Error ? full.message : null).toBe(NO_ROOM)
    room = null
    failWrites = true
    const quota = await fetchFrom(x, 'f', { size: data.length }).got.catch((e: unknown) => e)
    expect(quota instanceof Error ? quota.message : null).toBe(NO_ROOM)
    failWrites = false
    const stop = new AbortController()
    const pending = fetchFrom(x, 'f', { size: data.length, signal: stop.signal }).got
    stop.abort()
    const canceled = await pending.catch((e: unknown) => e)
    expect(canceled instanceof Error ? canceled.message : null).toBe(CANCELED)
    await new Promise(r => setTimeout(r, 0))
    expect([...kept.keys()].filter(k => k.startsWith('d:'))).toEqual([])
  })

  test('older peers still get and send a single base64 message, capped', async () => {
    const { m, x } = manager()
    await m.storeFile('f', new File([bytes(10)], 'f.bin', { type: 'a/b' }), null)
    const { client, host } = pipe()
    const answers: unknown[] = []
    client.on('data', d => answers.push(d))
    x.serve(host)
    await ask(x, host, { id: 'f' })
    await new Promise(r => setTimeout(r, 20))
    const answer = answers[0] as { type: string; data: string; mime: string }
    expect(answer.type).toBe('file')
    expect(answer.mime).toBe(NEUTRAL_TYPE)
    expect(new Uint8Array(await base64ToBlob(answer.data, 'a/b').arrayBuffer())).toEqual(bytes(10))
    expect(LEGACY_MAX).toBe(25 * 1024 * 1024)
  })

  const hostile = async (size: number | null, ...msgs: unknown[]) => {
    const { client } = pipe()
    const { m, x } = manager('viewer')
    x.ensurePeer = () => ({ connect: () => client })
    const got = m.download('host', 'f', { size, sha256: null, hoster: 'host' })
    await new Promise(r => setTimeout(r, 0))
    client.emit('open')
    for (const msg of msgs) client.emit('data', msg)
    const e = await got.catch((err: unknown) => err)
    return e instanceof Error ? e.message : 'ok'
  }

  test('a hostile hoster cannot make a download buffer more than the file size', async () => {
    const meta = (size: unknown) => ({ type: 'meta', id: 'f', mime: 'a/b', size })
    const chunk = (data: unknown) => ({ type: 'chunk', id: 'f', data })
    const big = 'P2P download failed: file too large'
    expect(await hostile(100, meta(101))).toBe(big)
    expect(await hostile(null, meta(26 * 1024 * 1024))).toBe(big)
    expect(await hostile(100, meta(-1))).toBe(big)
    expect(await hostile(100, meta(Infinity))).toBe(big)
    expect(await hostile(100, meta(NaN))).toBe(big)
    expect(await hostile(100, meta('5'))).toBe(big)
    expect(await hostile(100, meta(4))).toBe('P2P download failed: wrong size')
    expect(await hostile(4, meta(4), chunk('abcd'))).toBe('P2P download failed: bad data')
    expect(await hostile(4, meta(4), chunk({ length: 4 }))).toBe('P2P download failed: bad data')
    expect(await hostile(4, meta(4), chunk(new Uint8Array(5)))).toBe(
      'P2P download failed: too much data'
    )
    expect(await hostile(4, meta(4), chunk(new Uint8Array(3)), chunk(new ArrayBuffer(2)))).toBe(
      'P2P download failed: too much data'
    )
    expect(
      await hostile(4, meta(4), chunk(new Uint8Array(3)), chunk(new ArrayBuffer(1)), {
        type: 'end',
        id: 'f',
      })
    ).toBe('ok')
    expect(await hostile(4, { type: 'busy', id: 'f' })).toBe(
      'The sender is busy, try again in a moment'
    )
  })

  test('legacy base64 replies over the size limit are rejected before decoding', async () => {
    const file = (data: unknown) => ({ type: 'file', id: 'f', name: 'n', mime: 'a/b', data })
    expect(await hostile(3, file('A'.repeat(1000)))).toBe('P2P download failed: file too large')
    expect(await hostile(3, file(42))).toBe('P2P download failed: file too large')
    expect(await hostile(2, file('AQID'))).toBe('P2P download failed: wrong size')
    expect(await hostile(3, file('AQID'))).toBe('ok')
  })

  test('the hoster serves a few transfers at once and a limited number per peer', async () => {
    const { m, x } = manager()
    await m.storeFile('f', new File([bytes(10)], 'f.bin'), null)
    const answers: string[] = []
    for (let i = 0; i < ASKS_PER_MIN + 2; i += 1) {
      const { client, host } = pipe(`greedy-${i}`)
      client.on('data', d => answers.push((d as { type: string }).type))
      x.serve(host)
      await ask(x, host, { id: 'f', chunked: true }, 'greedy')
      await new Promise(r => setTimeout(r, 5))
    }
    expect(answers.filter(t => t === 'busy').length).toBe(2)
    const { client, host } = pipe('polite')
    const other: string[] = []
    client.on('data', d => other.push((d as { type: string }).type))
    x.serve(host)
    await ask(x, host, { id: 'f', chunked: true })
    await new Promise(r => setTimeout(r, 5))
    expect(other[0]).toBe('meta')
    const busy = m as unknown as { serving: number }
    busy.serving = SERVE_MAX
    const late: string[] = []
    const extra = pipe('late')
    extra.client.on('data', d => late.push((d as { type: string }).type))
    x.serve(extra.host)
    await ask(x, extra.host, { id: 'f', chunked: true })
    await new Promise(r => setTimeout(r, 5))
    expect(late).toEqual(['busy'])
  })

  test('the hoster serves only requests with a token for this file, this tab and this peer', async () => {
    const { m, x } = manager()
    await m.storeFile('f', new File([bytes(10)], 'f.bin'), null)
    const answer = async (token: unknown, peer = 'remote') => {
      const { client, host } = pipe(peer)
      const seen: string[] = []
      client.on('data', d => seen.push((d as { type: string }).type))
      x.serve(host)
      host.emit('data', { type: 'get', id: 'f', chunked: true, token })
      await new Promise(r => setTimeout(r, 20))
      return seen[0]
    }
    const good = (over: object = {}) => tokenFor(m, 'f', 'remote', 'viewer', over)
    expect(await answer(await good())).toBe('meta')
    expect(await answer(undefined)).toBe('missing')
    expect(await answer(42)).toBe('missing')
    expect(await answer('x')).toBe('missing')
    expect(await answer('a'.repeat(5000))).toBe('missing')
    expect(await answer(await good(), 'someone-else')).toBe('missing')
    for (const over of [
      { f: 'g' },
      { rp: 'other' },
      { h: 'mallory' },
      { hp: 'old-peer' },
      { exp: nowS() - 1 },
      { v: 2 },
      { r: 5 },
    ])
      expect(await answer(await good(over))).toBe('missing')
    const other = await mint(
      { v: 1, m: 7, f: 'f', r: 'v', h: 'host', hp: m.peerId(), rp: 'remote', exp: nowS() + 60 },
      new Uint8Array(32).fill(8)
    )
    expect(await answer(other)).toBe('missing')
    const [payload, sig] = (await good()).split('.')
    const forged = b64url(
      new TextEncoder().encode(
        JSON.stringify({
          ...(JSON.parse(atob(payload.replace(/-/g, '+').replace(/_/g, '/'))) as object),
          f: 'g',
        })
      )
    )
    expect(await answer(`${forged}.${sig}`)).toBe('missing')

    m.setServeKey(KEY_HEX, m.peerId(), nowS() - 1000)
    expect(await answer(await good({ exp: nowS() - 900 }))).toBe('meta')
    expect(await answer(await good({ exp: nowS() - 1001 }))).toBe('missing')
    const old = await good({ exp: nowS() - 900 })
    ;(x as unknown as { taken: (peer: unknown) => void }).taken({ destroy: () => {} })
    expect(await answer(old)).toBe('missing')
  })

  test('tokens made by the server check out here', async () => {
    const m = new P2pManager()
    ;(m as unknown as { announce: () => void }).announce = () => {}
    m.setAccount('alice')
    const x = m as unknown as {
      id: string
      tokenUser: (t: unknown, f: string, p: string) => Promise<string | null>
    }
    x.id = 'peer-a'
    m.setServeKey(
      '41c3150761935a54207ccffc105ef1bf167f5fbabe7a3a57e54d0a2aaeeb9d04',
      'peer-a',
      null
    )
    const vector =
      'eyJ2IjoxLCJtIjo3LCJmIjoiZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmYiLCJyIjoiYm9iIiwiaCI6ImFsaWNlIiwiaHAiOiJwZWVyLWEiLCJycCI6InBlZXItYiIsImV4cCI6NDEwMjQ0NDgwMH0.L7mKruWXwN9UL2xjXyqzUCW88A_LJAfvWoJzRpWiLfo'
    expect(await x.tokenUser(vector, 'f'.repeat(32), 'peer-b')).toBe('bob')
    expect(await x.tokenUser(vector, 'f'.repeat(32), 'peer-c')).toBeNull()
  })

  test('files, peer ids and downloads are kept per account', async () => {
    const { m } = manager('alice')
    await m.storeFile('a', new File([bytes(3)], 'a.bin'), null)
    const alicePeer = m.peerId()
    m.setAccount('bob')
    expect(m.files()).toEqual({})
    expect(m.file('a')).toBeNull()
    expect(m.peerId() === alicePeer).toBe(false)
    expect(await m.blob('a')).toBeNull()
    m.setAccount('alice')
    expect(m.file('a')?.name).toBe('a.bin')
    expect(m.peerId() === alicePeer).toBe(false)
    kept.set('d:alice:x', new Blob(['x']))
    kept.set('d:alice:x\u000000000000', new Blob(['x']))
    m.signOut()
    await Promise.resolve()
    expect([...kept.keys()].sort()).toEqual(['h:alice:a'])
    expect(m.files()).toEqual({})
    const none = await m
      .download('p', 'x', { size: 1, sha256: null, hoster: 'p' })
      .catch((e: unknown) => e)
    expect(none instanceof Error).toBe(true)
  })

  test('the server reconciles hosted files: removed ones stop, older files find their owner', async () => {
    const now = Math.floor(Date.now() / 1000)
    localStorage.setItem(
      'rchat_p2p_files',
      JSON.stringify({
        mine: { name: 'l', mime: 'a/b', size: 3, data: 'AQID', expires_at: null },
        theirs: { name: 't', mime: 'a/b', size: 1, expires_at: null },
      })
    )
    kept.set('theirs', new Blob(['t']))
    const { m } = manager('alice')
    const files = m as unknown as { cached: Record<string, StoredFile> }
    files.cached = {
      posted: { ...file(null), message_id: 1, added_at: now - 600 },
      sending: { ...file(null), added_at: now },
      old: file(null),
    }
    await m.reconcile(['mine'], ['posted', 'sending', 'old', 'mine', 'theirs'])
    expect(Object.keys(m.files()).sort()).toEqual(['mine', 'sending'])
    expect(kept.get('h:alice:mine')?.size).toBe(3)
    expect(JSON.parse(localStorage.getItem('rchat_p2p_files') ?? '{}')).toEqual({
      theirs: { name: 't', mime: 'a/b', size: 1, expires_at: null },
    })
    expect(kept.has('theirs')).toBe(true)
  })

  test('removal events stop serving files of that message', async () => {
    const { m, x } = manager()
    await m.storeFile('f', new File([bytes(3)], 'f.bin'), null)
    m.posted('f', 42)
    m.forgetMessage(41)
    expect(m.file('f') === null).toBe(false)
    m.forgetMessage(42)
    expect(m.file('f')).toBeNull()
    await Promise.resolve()
    expect(kept.has('h:host:f')).toBe(false)
    const gone = await fetchFrom(x, 'f').got.catch((e: unknown) => e)
    expect(gone instanceof Error ? gone.message : null).toBe('File not available')
  })

  test('the hosting announce stays one small frame: newest 256 ids, each relay list once', () => {
    const label = (c: string, n: number) => c.repeat(n)
    const hosts = [0, 1, 2, 3].map(
      i => `${i}${label('a', 62)}.${label('b', 63)}.${label('c', 63)}.${label('d', 61)}`
    )
    expect(hosts.every(h => h.length === 253)).toBe(true)
    const files: [string, StoredFile][] = Array.from({ length: 5000 }, (_, i) => [
      i.toString(16).padStart(32, '0'),
      { name: 'f', mime: 'a/b', size: 1, expires_at: null, added_at: 1_700_000_000 + i },
    ])
    files.push(['f'.repeat(32), { ...files[0][1], added_at: 1_800_000_000, pending: true }])
    const msg = hostingMsg('rchat-0123456789abcdef', files, ['legacy'], () => hosts)
    expect(new TextEncoder().encode(JSON.stringify(msg)).length < 64 * 1024).toBe(true)
    expect(msg.ids.length).toBe(HOSTED_MAX)
    expect(msg.ids[0]).toBe((4999).toString(16).padStart(32, '0'))
    expect(msg.ids.at(-1)).toBe((5000 - HOSTED_MAX).toString(16).padStart(32, '0'))
    expect(msg.relay_sets).toEqual([{ hosts, ids: msg.ids }])
    // Files kept by older versions go last, and lists differ per relay choice.
    const few = hostingMsg('p', files.slice(0, 3), ['legacy'], id =>
      id.endsWith('1') ? ['turn.a.example'] : []
    )
    expect(few.ids).toEqual([files[2][0], files[1][0], files[0][0], 'legacy'])
    expect(few.relay_sets).toEqual([{ hosts: ['turn.a.example'], ids: [files[1][0]] }])
    expect('relay_sets' in hostingMsg('p', files.slice(0, 1), [], () => [])).toBe(false)
  })

  test('a staged file is neither announced nor served until its message is posted', async () => {
    const { m, x } = manager()
    const announced: string[][] = []
    const ws = home.ws as unknown as { sendVoice: (msg: { ids?: string[] }) => void }
    const realSend = ws.sendVoice
    ws.sendVoice = msg => announced.push(msg.ids ?? [])
    ;(x as unknown as { ensurePeer: () => unknown }).ensurePeer = () => ({})
    x.announce = P2pManager.prototype.announce.bind(m)
    try {
      await m.storeFile('old', new File([bytes(3)], 'o.bin'), null)
      await m.stage('new', new File([bytes(3)], 'n.bin'), null)
      expect(announced).toEqual([['old']])
      m.announce()
      expect(announced.at(-1)).toEqual(['old'])
      const early = await fetchFrom(x, 'new').got.catch((e: unknown) => e)
      expect(early instanceof Error ? early.message : null).toBe('File not available')
      m.posted('new', 9)
      expect(announced.at(-1)).toEqual(['old', 'new'])
      expect(m.file('new')?.pending).toBeUndefined()
      expect((await fetchFrom(x, 'new').got).blob.size).toBe(3)
      await m.stage('dropped', new File([bytes(3)], 'd.bin'), null)
      const count = announced.length
      m.removeFile('dropped')
      expect(announced.length).toBe(count)
      expect(kept.has('h:host:dropped')).toBe(false)
    } finally {
      ws.sendVoice = realSend
    }
  })

  test('a staged file whose send never finished is dropped after a while', async () => {
    const { m } = manager()
    await m.stage('stuck', new File([bytes(3)], 's.bin'), null)
    await m.stage('fresh', new File([bytes(3)], 'f.bin'), null)
    const files = (m as unknown as { cached: Record<string, StoredFile> }).cached
    files.stuck = { ...files.stuck, added_at: Math.floor(Date.now() / 1000) - 3601 }
    m.purgeExpired()
    expect(Object.keys(m.files())).toEqual(['fresh'])
  })

  test("two messages reusing an id each get their own hoster's verified file", async () => {
    const id = 'c3'.repeat(16)
    const real = bytes(500, PNG)
    const fake = bytes(700, [0x47, 0x49, 0x46, 0x38, 0x39, 0x61])
    const hosts = { alice: manager('alice'), mallory: manager('mallory') }
    await hosts.alice.m.storeFile(id, new File([real], 'a.png'), null, hex(real))
    await hosts.mallory.m.storeFile(id, new File([fake], 'a.png'), null, hex(fake))
    localStorage.setItem(
      'rchat_p2p_got:viewer',
      JSON.stringify({ [id]: { message_id: 1, size: 3, type: 'image/png', verified: true, at: 1 } })
    )
    kept.set(`d:viewer:${id}`, new Blob(['old']))
    const { m: viewer, x: vx } = manager('viewer')
    vx.ensurePeer = () => ({
      connect: (peer: 'alice' | 'mallory') => {
        const { client, host } = pipe('viewer-peer')
        hosts[peer].x.serve(host)
        setTimeout(() => client.emit('open'), 0)
        return client
      },
    })
    expect(viewer.received()).toEqual({})
    await Promise.resolve()
    expect(kept.has(`d:viewer:${id}`)).toBe(false)
    const one = await viewer.download('alice', id, {
      token: await tokenFor(hosts.alice.m, id, 'viewer-peer'),
      size: real.length,
      sha256: hex(real),
      hoster: 'alice',
      messageId: 1,
    })
    const two = await viewer.download('mallory', id, {
      token: await tokenFor(hosts.mallory.m, id, 'viewer-peer'),
      size: fake.length,
      sha256: hex(fake),
      hoster: 'mallory',
      messageId: 2,
    })
    expect([one.type, one.verified, two.type, two.verified]).toEqual([
      'image/png',
      true,
      'image/gif',
      true,
    ])
    const content = async (hoster: string, sha: string | null) => {
      const got = await viewer.receivedFile(id, hoster, sha)
      return got ? new Uint8Array(await got.blob.arrayBuffer()) : null
    }
    expect(await content('alice', hex(real))).toEqual(real)
    expect(await content('mallory', hex(fake))).toEqual(fake)
    expect(await content('mallory', hex(real))).toBeNull()
    expect(await content('alice', hex(fake))).toBeNull()
    expect(await content('alice', null)).toBeNull()
    keepPreview(1, { url: 'blob:one', kind: 'image' })
    keepPreview(2, { url: 'blob:two', kind: 'image' })
    expect([previewUrl(1)?.url, previewUrl(2)?.url]).toEqual(['blob:one', 'blob:two'])
    viewer.forgetMessage(2)
    await Promise.resolve()
    expect([previewUrl(1)?.url, previewUrl(2)]).toEqual(['blob:one', null])
    expect(await content('mallory', hex(fake))).toBeNull()
    expect(await content('alice', hex(real))).toEqual(real)
    viewer.received()[`${id}:${hex(real)}:alice`].hoster = 'mallory'
    expect(await content('alice', hex(real))).toBeNull()
  })

  const tick = (ms = 0) => new Promise(r => setTimeout(r, ms))

  test('a stalled downloader frees its slot', async () => {
    const { m, x } = manager()
    await m.storeFile('f', new File([bytes(CHUNK_BYTES * 3)], 'f.bin'), null)
    ;(m as unknown as { stallMs: number }).stallMs = 40
    const { client, host } = pipe('slow')
    const seen: string[] = []
    client.on('data', d => seen.push((d as { type: string }).type))
    host.bufferSize = 100
    x.serve(host)
    await ask(x, host, { id: 'f', chunked: true })
    await tick(10)
    const state = m as unknown as { serving: number; servingBy: Map<string, number> }
    expect([state.serving, host.open]).toEqual([1, true])
    await tick(120)
    expect([state.serving, state.servingBy.size, host.open, seen]).toEqual([0, 0, false, ['meta']])
  })

  test('a transfer past its deadline is cut off even when a send never returns', async () => {
    expect(serveDeadline(0)).toBe(120_000)
    expect(serveDeadline(64 * 1024 * 100)).toBe(220_000)
    const { m, x } = manager()
    await m.storeFile('f', new File([bytes(CHUNK_BYTES * 2)], 'f.bin'), null)
    ;(m as unknown as { deadlineMs: () => number }).deadlineMs = () => 40
    const { host } = pipe('trickle')
    host.send = async (msg: unknown) => {
      if ((msg as { type: string }).type === 'chunk') await new Promise(() => {})
    }
    x.serve(host)
    await ask(x, host, { id: 'f', chunked: true })
    await tick(10)
    const state = m as unknown as { serving: number }
    expect(state.serving).toBe(1)
    await tick(80)
    expect([state.serving, host.open]).toEqual([0, false])
  })

  test('one peer holds at most a few transfers at once', async () => {
    const { m, x } = manager()
    await m.storeFile('f', new File([bytes(CHUNK_BYTES * 2)], 'f.bin'), null)
    let n = 0
    const start = async (user: string) => {
      const { client, host } = pipe(`${user}-${(n += 1)}`)
      const seen: string[] = []
      client.on('data', d => seen.push((d as { type: string }).type))
      host.send = async (msg: unknown) => {
        const type = (msg as { type: string }).type
        if (type === 'chunk') await new Promise(() => {})
        seen.push(type)
      }
      x.serve(host)
      await ask(x, host, { id: 'f', chunked: true }, user)
      return { seen, host }
    }
    const held: { seen: string[]; host: { close: () => void } }[] = []
    for (let i = 0; i < PEER_SERVE_MAX; i += 1) held.push(await start('greedy'))
    await tick(10)
    const extra = await start('greedy')
    const other = await start('other')
    await tick(10)
    expect(held.map(h => h.seen)).toEqual(held.map(() => ['meta']))
    expect([extra.seen, other.seen]).toEqual([['busy'], ['meta']])
    held[0].host.close()
    const again = await start('greedy')
    await tick(10)
    expect(again.seen).toEqual(['meta'])
  })

  test('older single-message replies stay capped even when the message declares more', async () => {
    const file = (data: unknown) => ({ type: 'file', id: 'f', name: 'n', mime: 'a/b', data })
    const over = 'A'.repeat(Math.ceil(LEGACY_MAX / 3) * 4 + 4)
    expect(await hostile(LEGACY_MAX * 4, file(over))).toBe('P2P download failed: file too large')
  })

  test('a store that falls behind stops the download instead of buffering it', async () => {
    stallWrites = true
    const n = PENDING_MAX / CHUNK_BYTES + 1
    const msgs: unknown[] = [{ type: 'meta', id: 'f', mime: 'a/b', size: CHUNK_BYTES * (n + 4) }]
    for (let i = 0; i < n + 4; i += 1)
      msgs.push({ type: 'chunk', id: 'f', data: new Uint8Array(CHUNK_BYTES) })
    expect(await hostile(CHUNK_BYTES * (n + 4), ...msgs)).toBe(SLOW_STORE)
  })

  test('the hoster sends no more than the ack window past what the downloader stored', async () => {
    const { m, x } = manager()
    const window = ACK_WINDOW / CHUNK_BYTES
    await m.storeFile('f', new File([bytes(CHUNK_BYTES * (window + 4))], 'f.bin'), null)
    ;(m as unknown as { stallMs: number }).stallMs = 200
    const { client, host } = pipe('acker')
    const seen: string[] = []
    client.on('data', d => seen.push((d as { type: string }).type))
    x.serve(host)
    await ask(x, host, { id: 'f', chunked: true, acks: true })
    await tick(60)
    const chunks = () => seen.filter(t => t === 'chunk').length
    expect([chunks(), seen.includes('end')]).toEqual([window + 1, false])
    host.emit('data', { type: 'ack', id: 'f', got: CHUNK_BYTES * 4 })
    await tick(60)
    expect([chunks(), seen.at(-1)]).toEqual([window + 4, 'end'])

    const quiet = pipe('silent')
    const got: string[] = []
    quiet.client.on('data', d => got.push((d as { type: string }).type))
    x.serve(quiet.host)
    await ask(x, quiet.host, { id: 'f', chunked: true, acks: true })
    await tick(400)
    expect([got.filter(t => t === 'chunk').length, quiet.host.open]).toEqual([window + 1, false])
    expect((m as unknown as { serving: number }).serving).toBe(0)
    const whole = await fetchFrom(x, 'f').got
    expect(whole.blob.size).toBe(CHUNK_BYTES * (window + 4))
  })

  test('a downloader acks only what its store took, so a slow store pauses the hoster', async () => {
    const { m, x } = manager()
    const window = ACK_WINDOW / CHUNK_BYTES
    await m.storeFile('f', new File([bytes(CHUNK_BYTES * (window + 8))], 'f.bin'), null)
    ;(m as unknown as { stallMs: number }).stallMs = 100
    stallWrites = true
    const sent: unknown[] = []
    const { got } = fetchFrom(x, 'f', {}, sent)
    const out = got.catch((e: unknown) => (e instanceof Error ? e.message : String(e)))
    const state = m as unknown as { serving: number }
    const chunks = () => sent.filter(s => (s as { type: string }).type === 'chunk').length
    for (let i = 0; i < 100 && chunks() <= window; i += 1) await tick(20)
    expect(state.serving).toBe(1)
    for (let i = 0; i < 100 && state.serving > 0; i += 1) await tick(20)
    expect([chunks(), state.serving]).toEqual([window + 1, 0])
    stallWrites = false
    const result = await Promise.race([out, tick(50).then(() => 'pending')])
    expect(result === SLOW_STORE).toBe(false)
  })

  test('canceling while the file is being finished waits for it, then cleans up', async () => {
    let open = () => {}
    finishGate = new Promise<void>(r => {
      open = r
    })
    const { client } = pipe()
    const { m, x } = manager('viewer')
    x.ensurePeer = () => ({ connect: () => client })
    const stop = new AbortController()
    const data = new Uint8Array([1, 2, 3, 4])
    const got = m.download('host', 'f', {
      size: 4,
      sha256: hex(data),
      hoster: 'host',
      messageId: 3,
      signal: stop.signal,
    })
    await tick()
    client.emit('open')
    client.emit('data', { type: 'meta', id: 'f', mime: 'a/b', size: 4 })
    client.emit('data', { type: 'chunk', id: 'f', data })
    client.emit('data', { type: 'end', id: 'f' })
    await tick()
    expect(log).toEqual(['finish'])
    stop.abort()
    const e = await got.catch((err: unknown) => err)
    expect(e instanceof Error ? e.message : null).toBe(CANCELED)
    await tick()
    expect(log).toEqual(['finish'])
    open()
    await tick(5)
    expect(log).toEqual(['finish', 'finished', 'abort'])
    expect([...kept.keys()].filter(k => k.startsWith('d:'))).toEqual([])
    expect(m.received()).toEqual({})
  })

  describe('relays', () => {
    const mine = 'turn' + ':mine.example:3478'
    // Relay edits make every manager still hosting announce again; keep that off the socket.
    const ws = home.ws as unknown as { sendVoice: (msg: unknown) => void }
    const realSend = ws.sendVoice
    // Whatever prompt was there (the store's, when another file loaded it) comes back after.
    const realPrompt = relayBook.prompt
    beforeEach(() => {
      ws.sendVoice = () => {}
    })
    afterEach(() => {
      relayBook.load(null)
      relayBook.prompt = () => Promise.resolve('deny')
      ws.sendVoice = realSend
    })
    afterAll(() => {
      relayBook.prompt = realPrompt
    })

    type Msg = { type: string; src?: string; dst?: string; payload: Record<string, unknown> }
    const AUTO_MARK = { iceServers: [], mark: 'peer default' } as RTCConfiguration
    // A Peer as PeerJS 1.5.5 has it: `_handleMessage` builds an offered connection from
    // `options.config` and emits it at once; `socket.send` goes to the broker.
    const fakePeer = (id: string, hook = true) => {
      const on = new Map<string, (x: unknown) => void>()
      const sent: Msg[] = []
      const built: { cid: string; config: unknown }[] = []
      const sides = new Map<string, ReturnType<typeof pipe>>()
      const peer: Record<string, unknown> = {
        id,
        destroyed: false,
        disconnected: false,
        options: { config: AUTO_MARK },
        socket: { send: (m: Msg) => sent.push(m) },
        on: (ev: string, fn: (x: unknown) => void) => {
          on.set(ev, fn)
          return peer
        },
        _getMessages: () => [],
      }
      if (hook)
        peer._handleMessage = function (this: { options: { config: unknown } }, msg: Msg) {
          if (msg.type !== 'OFFER' || msg.payload.type !== 'data') return
          const cid = String(msg.payload.connectionId)
          built.push({ cid, config: this.options.config })
          const p = sides.get(cid) ?? pipe(String(msg.src))
          Object.assign(p.host, {
            connectionId: cid,
            metadata: msg.payload.metadata,
            label: msg.payload.label,
          })
          on.get('connection')?.(p.host)
          setTimeout(() => p.client.emit('open'), 0)
        }
      const offer = (src: string, cid: string, metadata?: unknown, label?: string) =>
        (peer._handleMessage as (m: Msg) => void)({
          type: 'OFFER',
          src,
          payload: { type: 'data', connectionId: cid, metadata, label },
        })
      return { peer, on, sent, built, sides, offer }
    }
    const hosting = async () => {
      relayBook.save({
        ...relayBook.prefs,
        relays: [{ url: mine, username: 'u', credential: 'c' }],
      })
      const { m, x } = manager()
      await m.stage('manual', new File([bytes(5)], 'r.bin'), null, undefined, mine)
      m.posted('manual', 3)
      await m.storeFile('auto', new File([bytes(4)], 'a.bin'), null)
      const net = fakePeer(m.peerId())
      x.wire(net.peer)
      return { m, x, net }
    }
    const manualConfig = {
      iceServers: [{ urls: mine, username: 'u', credential: 'c' }],
      iceTransportPolicy: 'relay',
    }
    const until = async (ok: () => boolean) => {
      for (let i = 0; i < 50 && !ok(); i += 1) await new Promise(r => setTimeout(r, 1))
    }

    test('PeerJS stays pinned at the version whose offer handling the hook relies on', () => {
      const pkg = JSON.parse(
        readFileSync(new URL('../../../package.json', import.meta.url), 'utf8')
      ) as {
        dependencies: Record<string, string>
      }
      expect(pkg.dependencies.peerjs).toBe('1.5.5')
      expect(canHookOffers(Peer.prototype)).toBe(true)
      expect(canHookOffers({})).toBe(false)
    })

    test('offers are read one way: mixed or malformed metadata is bad', () => {
      expect(intentOf('data', undefined, undefined)).toEqual({ kind: 'auto' })
      expect(intentOf('data', undefined, { f: 'x', r: ['a'], t: 'k' })).toEqual({
        kind: 'file',
        id: 'x',
        relays: ['a'],
        token: 'k',
      })
      expect(intentOf('data', 'call', { call: 1 })).toEqual({ kind: 'call' })
      expect(intentOf('media', undefined, { call: 1 })).toEqual({ kind: 'call' })
      for (const [type, label, meta] of [
        ['data', undefined, { call: 1, f: 'x' }],
        ['data', undefined, { call: 1 }],
        ['data', 'call', { f: 'x' }],
        ['data', 'call', { call: 1, f: 'x' }],
        ['media', undefined, { f: 'x' }],
        ['media', undefined, { call: 1, f: 'x' }],
        ['data', undefined, { f: 7 }],
        ['data', undefined, 'x'],
        ['other', undefined, undefined],
      ] as const)
        expect(intentOf(type, label, meta)).toEqual({ kind: 'bad' })
    })

    test('an offer gets the config of the file it names, and the Peer default is restored', async () => {
      const { m, net } = await hosting()
      const opts = net.peer.options as { config: unknown }
      const token = await tokenFor(m, 'manual', 'remote')
      net.offer('remote', 'c1', { f: 'manual', t: token })
      await until(() => net.built.length === 1)
      expect(net.built[0].config).toEqual(manualConfig)
      expect(opts.config).toBe(AUTO_MARK)
      net.offer('remote', 'c2')
      net.offer('remote', 'c3', { f: 'auto' })
      expect(net.built.slice(1).map(b => b.config)).toEqual([
        relayBook.autoConfig(),
        relayBook.autoConfig(),
      ])
      expect(opts.config).toBe(AUTO_MARK)
    })

    test('a relay-pinned file is served only on a connection answered on its relay plan', async () => {
      const { m, x, net } = await hosting()
      const fetchOn = async (cid: string, id: string, meta: unknown, label?: string) => {
        const p = pipe('remote')
        net.sides.set(cid, p)
        const sent: unknown[] = []
        const send = p.host.send.bind(p.host)
        p.host.send = async (msg: unknown) => {
          sent.push(msg)
          await send(msg)
        }
        net.offer('remote', cid, meta, label)
        await until(() => net.built.some(b => b.cid === cid))
        const token = await tokenFor(m, id, 'remote')
        p.host.emit('data', { type: 'get', id, chunked: true, token })
        await until(() => sent.length > 0 || !p.host.open)
        await until(() => sent.some(s => (s as { type: string }).type === 'end') || !p.host.open)
        return sent.map(s => (s as { type: string }).type)
      }
      const token = await tokenFor(m, 'manual', 'remote')
      expect((await fetchOn('a', 'manual', { f: 'manual', t: token })).at(-1)).toBe('end')
      // Metadata naming another file, no metadata, or a call id next to the file: refused.
      expect(await fetchOn('b', 'manual', { f: 'auto' })).toEqual(['missing'])
      expect(await fetchOn('c', 'manual', undefined)).toEqual(['missing'])
      expect(await fetchOn('d', 'manual', { call: 1, f: 'manual', t: token })).toEqual([])
      expect(net.built.find(b => b.cid === 'd')?.config).toEqual({
        iceServers: [],
        iceTransportPolicy: 'relay',
      })
      expect(await fetchOn('e', 'manual', { call: 1, f: 'manual', t: token }, 'call')).toEqual([])
      expect((await fetchOn('f', 'auto', { f: 'auto' })).at(-1)).toBe('end')
      // Without the hook every connection is on the auto config: pinned files are refused.
      const bare = fakePeer('bare', false)
      x.wire(bare.peer)
      const p = pipe('remote')
      Object.assign(p.host, { connectionId: 'z', metadata: { f: 'manual', t: token } })
      const sent: unknown[] = []
      p.host.send = async (msg: unknown) => void sent.push(msg)
      bare.on.get('connection')?.(p.host)
      p.client.other = null
      p.host.emit('data', { type: 'get', id: 'manual', chunked: true, token })
      await until(() => sent.length > 0)
      expect(sent).toEqual([{ type: 'missing', id: 'manual' }])
    })

    test('a pinned file offer with a bad token is refused before any peer connection', async () => {
      const { net } = await hosting()
      net.offer('remote', 'c1', { f: 'manual', t: 'nope' })
      await until(() => net.sent.length > 0)
      expect(net.built).toEqual([])
      expect(net.sent).toEqual([
        {
          type: 'OFFER',
          dst: 'remote',
          payload: { type: REFUSED, connectionId: 'c1', reason: 'missing' },
        },
      ])
    })

    test("the hoster is asked about a downloader's unknown relay before answering", async () => {
      const { m, net } = await hosting()
      const asked: string[] = []
      const answers: Decision[] = ['deny', 'once', 'always']
      relayBook.prompt = async host => {
        asked.push(host)
        return answers.shift() ?? 'deny'
      }
      let t = 1_000_000
      relayBook.now = () => t
      const meta = async (host = 'their.example') => ({
        f: 'auto',
        r: [host],
        t: await tokenFor(m, 'auto', 'remote'),
      })
      net.offer('remote', 'deny', await meta())
      await until(() => net.sent.length > 0)
      expect(net.built).toEqual([])
      expect(net.sent.at(-1)?.payload).toEqual({
        type: REFUSED,
        connectionId: 'deny',
        reason: 'relay',
      })
      // Denied: the same downloader with the same relays isn't asked again.
      t += PROMPTS.recentMs
      net.offer('remote', 'again', await meta())
      await until(() => net.sent.length > 1)
      expect(net.sent.at(-1)?.payload.connectionId).toBe('again')
      net.offer('remote', 'once', await meta('other.example'))
      await until(() => net.built.length === 1)
      expect(relayBook.prefs.allowed).toEqual([])
      t += PROMPTS.recentMs
      net.offer('remote', 'always', await meta('other.example'))
      await until(() => net.built.length === 2)
      expect(relayBook.prefs.allowed).toEqual(['other.example'])
      net.offer('remote', 'known', await meta('other.example'))
      expect(net.built.map(b => b.cid)).toEqual(['once', 'always', 'known'])
      expect(asked).toEqual(['their.example', 'other.example', 'other.example'])
      relayBook.now = () => Date.now()
      // A bad token never gets a prompt; a pinned file's relay hides the IP, so no prompt.
      relayBook.save({ ...relayBook.prefs, allowed: [] })
      net.offer('remote', 'forged', { f: 'auto', r: ['their.example'], t: 'nope' })
      const token = await tokenFor(m, 'manual', 'remote')
      net.offer('remote', 'relayed', { f: 'manual', r: ['their.example'], t: token })
      await until(() => net.built.length === 4)
      expect(net.built.at(-1)?.cid).toBe('relayed')
      expect(net.sent.at(-1)?.payload).toEqual({
        type: REFUSED,
        connectionId: 'forged',
        reason: 'missing',
      })
      expect(asked.length).toBe(3)
    })

    test('offers waiting for an answer are capped, per downloader and in all, for a while', async () => {
      const { m, x, net } = await hosting()
      relayBook.prompt = () => new Promise(() => {})
      const t = await tokenFor(m, 'auto', 'remote')
      for (let i = 0; i <= HELD_PER_PEER; i += 1)
        net.offer('remote', `c${i}`, { f: 'auto', r: ['their.example'], t })
      expect(net.sent.map(x => x.payload.reason)).toEqual(['busy'])
      const others = HELD_OFFERS_MAX - HELD_PER_PEER + 1
      for (let i = 0; i < others; i += 1)
        net.offer(`r${i}`, `d${i}`, {
          f: 'auto',
          r: ['their.example'],
          t: await tokenFor(m, 'auto', `r${i}`),
        })
      expect(net.sent.map(x => x.payload.connectionId)).toEqual(['c2', `d${others - 1}`])
      // An answer that never comes frees the slot once the downloader stopped waiting.
      x.heldMs = 20
      net.offer('late', 'e0', { f: 'auto', r: ['their.example'], t })
      expect(net.sent.at(-1)?.payload.connectionId).toBe('e0')
    })

    test('an offer held past the wait is refused and frees its slot', async () => {
      const { m, x, net } = await hosting()
      x.heldMs = 20
      relayBook.prompt = () => new Promise(() => {})
      const t = await tokenFor(m, 'auto', 'remote')
      net.offer('remote', 'c0', { f: 'auto', r: ['their.example'], t })
      net.offer('remote', 'c1', { f: 'auto', r: ['their.example'], t })
      expect(net.sent).toEqual([])
      await until(() => net.sent.length === 2)
      expect(net.sent.map(s => [s.payload.connectionId, s.payload.reason])).toEqual([
        ['c0', 'busy'],
        ['c1', 'busy'],
      ])
      net.offer('remote', 'c2', { f: 'auto', r: ['their.example'], t })
      expect(net.sent.length).toBe(2)
    })

    test('a download declares its relays and token, and stops when the hoster refuses', async () => {
      relayBook.save({ ...relayBook.prefs, relays: [{ url: mine }] })
      const { m, x } = manager('viewer')
      const net = fakePeer('viewer')
      const connects: { metadata: unknown }[] = []
      const { client } = pipe('host')
      Object.assign(client, { connectionId: 'c9' })
      Object.assign(net.peer, {
        connect: (_to: string, o: { metadata: unknown }) => {
          connects.push(o)
          return client
        },
      })
      x.wire(net.peer)
      x.ensurePeer = () => net.peer
      const got = m
        .download('hostpeer', 'f', { size: null, sha256: null, hoster: 'host', token: 'tok' })
        .catch((e: unknown) => e)
      await until(() => connects.length > 0)
      expect(connects[0].metadata).toEqual({ f: 'f', r: ['mine.example'], t: 'tok' })
      // Only the hoster's refusal for this connection counts.
      net.offer('someone', 'c9')
      ;(net.peer._handleMessage as (m: Msg) => void)({
        type: 'OFFER',
        src: 'hostpeer',
        payload: { type: REFUSED, connectionId: 'c9', reason: 'relay' },
      })
      const e = await got
      expect(e instanceof Error ? e.message : null).toBe(REFUSED_RELAY)
    })

    test('a download asks before using a relay the hoster declared that it does not know', async () => {
      const { m, x } = manager()
      await m.storeFile('f', new File([bytes(6)], 'f.bin'), null)
      const asked: string[] = []
      const answers: Decision[] = ['deny', 'once', 'always']
      relayBook.prompt = async host => {
        asked.push(host)
        return answers.shift() ?? 'deny'
      }
      let t = 1_000_000
      relayBook.now = () => t
      const relays = ['their.example']
      const denied = await fetchFrom(x, 'f', { relays }).got.catch((e: unknown) => e)
      expect(denied instanceof Error ? denied.message : null).toBe(DENIED_DOWNLOAD)
      expect((await fetchFrom(x, 'f', { relays }).got).blob.size).toBe(6)
      expect(relayBook.prefs.allowed).toEqual([])
      // Allowed once a moment ago: no second prompt yet.
      expect((await fetchFrom(x, 'f', { relays }).got).blob.size).toBe(6)
      expect(asked.length).toBe(2)
      t += PROMPTS.recentMs
      expect((await fetchFrom(x, 'f', { relays }).got).blob.size).toBe(6)
      expect(relayBook.prefs.allowed).toEqual(['their.example'])
      expect((await fetchFrom(x, 'f', { relays }).got).blob.size).toBe(6)
      expect(asked).toEqual(['their.example', 'their.example', 'their.example'])
      relayBook.now = () => Date.now()
    })

    test('hosting declares the relay hosts each file may be served through', async () => {
      relayBook.save({ ...relayBook.prefs, relays: [{ url: mine }] })
      const { m, x } = manager()
      const msgs: { ids?: string[]; relay_sets?: { hosts: string[]; ids: string[] }[] }[] = []
      ws.sendVoice = msg => msgs.push(msg as (typeof msgs)[number])
      x.ensurePeer = () => ({})
      x.announce = P2pManager.prototype.announce.bind(m)
      try {
        await m.stage('manual', new File([bytes(3)], 'm.bin'), null, undefined, mine)
        m.posted('manual', 1)
        expect(msgs.at(-1)?.relay_sets).toEqual([{ hosts: ['mine.example'], ids: ['manual'] }])
        relayBook.save({ ...relayBook.prefs, relays: [] })
        expect(msgs.at(-1)?.relay_sets).toBeUndefined()
        expect(msgs.at(-1)?.ids).toEqual(['manual'])
      } finally {
        ws.sendVoice = () => {}
      }
    })
  })
})

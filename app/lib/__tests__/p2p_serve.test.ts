import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  base64ToBlob,
  CHUNK_BYTES,
  expiryDelay,
  p2p,
  P2pManager,
  servable,
  type StoredFile,
  unexpired,
} from '../p2p'
import { setBlobs, type BlobStore } from '../platform'
import { webBlobs } from '../platform/web_blobs'

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
  const manager = p2p as unknown as { cached: unknown; id: unknown; announce: () => void }
  const realAnnounce = manager.announce
  afterEach(() => {
    g.localStorage = real
    console.warn = realWarn
    manager.announce = realAnnounce
    manager.cached = null
    manager.id = null
  })

  test('the peer id stays the same when storage is unavailable', () => {
    manager.id = null
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
    const id = p2p.peerId()
    expect(/^[0-9a-f]+$/.test(id)).toBe(true)
    expect(p2p.peerId()).toBe(id)
  })

  test('a peer id taken by another tab is replaced for this tab only', () => {
    const local = new Map<string, string>([['rchat_peer_id', 'abc']])
    g.localStorage = {
      getItem: (k: string) => local.get(k) ?? null,
      setItem: (k: string, v: string) => void local.set(k, v),
      removeItem: (k: string) => void local.delete(k),
    }
    const m = new P2pManager()
    const x = m as unknown as { taken: (peer: unknown) => void; announce: () => void }
    let announced = 0
    x.announce = () => {
      announced += 1
    }
    expect(m.peerId()).toBe('abc')
    let destroyed = false
    x.taken({
      destroy: () => {
        destroyed = true
      },
    })
    const fresh = m.peerId()
    expect(/^[0-9a-f]{32}$/.test(fresh)).toBe(true)
    expect([destroyed, announced, local.get('rchat_peer_id')]).toEqual([true, 1, 'abc'])
    expect(m.peerId()).toBe(fresh)
  })

  test('removing and expiring files never throws when storage writes fail', () => {
    manager.cached = { old: file(1), kept: file(null), gone: file(null) }
    console.warn = () => {}
    g.localStorage = {
      getItem: () => null,
      setItem: () => {
        throw new Error('full')
      },
      removeItem: () => {},
    }
    let announced = 0
    manager.announce = () => {
      announced += 1
    }
    p2p.purgeExpired()
    p2p.removeFile('gone')
    expect(Object.keys(p2p.files())).toEqual(['kept'])
    expect(announced).toBe(2)
  })
})

type Handler = (arg?: unknown) => void

function pipe() {
  const make = () => {
    const on = new Map<string, Handler>()
    return {
      open: true,
      bufferSize: 0,
      peer: null as null | { emit: (e: string, a?: unknown) => void },
      on(event: string, cb: Handler) {
        on.set(event, cb)
      },
      emit(event: string, arg?: unknown) {
        on.get(event)?.(arg)
      },
      async send(msg: unknown) {
        await Promise.resolve()
        this.peer?.emit('data', structuredClone(msg))
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
  client.peer = host
  host.peer = client
  return { client, host }
}

describe('p2p transfer', () => {
  const g = globalThis as { localStorage?: unknown }
  const real = g.localStorage
  const kept = new Map<string, Blob>()
  const store: BlobStore = {
    put: async (k, b) => {
      kept.set(k, b)
    },
    get: async k => kept.get(k) ?? null,
    remove: async k => {
      kept.delete(k)
    },
  }
  type Wire = {
    serve: (conn: unknown) => void
    ensurePeer: () => unknown
    announce: () => void
  }
  const manager = () => {
    const m = new P2pManager()
    const x = m as unknown as Wire
    x.announce = () => {}
    return { m, x }
  }
  const bytes = (n: number) => {
    const out = new Uint8Array(n)
    for (let i = 0; i < n; i += 1) out[i] = (i * 31) % 251
    return out
  }
  const fetchFrom = (host: Wire, id: string, sent?: string[]) => {
    const { client, host: side } = pipe()
    const { m, x } = manager()
    x.ensurePeer = () => ({ connect: () => client })
    if (sent) {
      const send = side.send.bind(side)
      side.send = async (msg: unknown) => {
        sent.push((msg as { type: string }).type)
        await send(msg)
      }
    }
    host.serve(side)
    const got = m.download('host', id)
    client.emit('open')
    return got
  }

  beforeEach(() => {
    const local = new Map<string, string>()
    g.localStorage = {
      getItem: (k: string) => local.get(k) ?? null,
      setItem: (k: string, v: string) => void local.set(k, v),
      removeItem: (k: string) => void local.delete(k),
    }
    kept.clear()
    setBlobs(store)
  })
  afterEach(() => {
    g.localStorage = real
    setBlobs(webBlobs)
  })

  test('files over the old localStorage limit are kept out of localStorage and stream in chunks', async () => {
    const { m, x } = manager()
    const size = CHUNK_BYTES * 3 + 17
    await m.storeFile('big', new File([bytes(size)], 'big.bin', { type: 'x/y' }), null)
    expect(kept.get('big')?.size).toBe(size)
    expect((localStorage.getItem('rchat_p2p_files')?.length ?? 0) < 200).toBe(true)
    const sent: string[] = []
    const blob = await fetchFrom(x, 'big', sent)
    expect(sent).toEqual(['meta', 'chunk', 'chunk', 'chunk', 'chunk', 'end'])
    expect(blob.type).toBe('x/y')
    expect(new Uint8Array(await blob.arrayBuffer())).toEqual(bytes(size))
    m.removeFile('big')
    await Promise.resolve()
    expect(kept.has('big')).toBe(false)
    const gone = await fetchFrom(x, 'big').catch((e: unknown) => e)
    expect(gone instanceof Error ? gone.message : null).toBe('File not available')
  })

  test('older peers still get and send a single base64 message', async () => {
    const { m, x } = manager()
    await m.storeFile('f', new File([bytes(10)], 'f.bin', { type: 'a/b' }), null)
    const { client, host } = pipe()
    const answers: unknown[] = []
    client.on('data', d => answers.push(d))
    x.serve(host)
    host.emit('data', { type: 'get', id: 'f' })
    await new Promise(r => setTimeout(r, 20))
    const answer = answers[0] as { type: string; data: string; mime: string }
    expect(answer.type).toBe('file')
    expect(new Uint8Array(await base64ToBlob(answer.data, 'a/b').arrayBuffer())).toEqual(bytes(10))

    const old = manager()
    localStorage.setItem(
      'rchat_p2p_files',
      JSON.stringify({
        legacy: { name: 'l', mime: 'a/b', size: 3, data: 'AQID', expires_at: null },
      })
    )
    const blob = await fetchFrom(old.x, 'legacy')
    expect([...new Uint8Array(await blob.arrayBuffer())]).toEqual([1, 2, 3])
  })

  const hostile = async (limit: number | undefined, ...msgs: unknown[]) => {
    const { client } = pipe()
    const { m, x } = manager()
    x.ensurePeer = () => ({ connect: () => client })
    const got = m.download('host', 'f', limit)
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
    expect(await hostile(undefined, meta(26 * 1024 * 1024))).toBe(big)
    expect(await hostile(100, meta(-1))).toBe(big)
    expect(await hostile(100, meta(Infinity))).toBe(big)
    expect(await hostile(100, meta(NaN))).toBe(big)
    expect(await hostile(100, meta('5'))).toBe(big)
    expect(await hostile(100, meta(4), chunk('abcd'))).toBe('P2P download failed: bad data')
    expect(await hostile(100, meta(4), chunk({ length: 4 }))).toBe('P2P download failed: bad data')
    expect(await hostile(100, meta(4), chunk(new Uint8Array(5)))).toBe(
      'P2P download failed: too much data'
    )
    expect(await hostile(100, meta(4), chunk(new Uint8Array(3)), chunk(new ArrayBuffer(2)))).toBe(
      'P2P download failed: too much data'
    )
    expect(
      await hostile(100, meta(4), chunk(new Uint8Array(3)), chunk(new ArrayBuffer(1)), {
        type: 'end',
        id: 'f',
      })
    ).toBe('ok')
  })

  test('legacy base64 replies over the size limit are rejected before decoding', async () => {
    const file = (data: unknown) => ({ type: 'file', id: 'f', name: 'n', mime: 'a/b', data })
    expect(await hostile(3, file('A'.repeat(1000)))).toBe('P2P download failed: file too large')
    expect(await hostile(3, file(42))).toBe('P2P download failed: file too large')
    expect(await hostile(3, file('AQID'))).toBe('ok')
  })

  test('files kept as base64 by older versions move to the blob store', async () => {
    localStorage.setItem(
      'rchat_p2p_files',
      JSON.stringify({
        legacy: { name: 'l', mime: 'a/b', size: 3, data: 'AQID', expires_at: null },
      })
    )
    const { m } = manager()
    m.ensurePurge()
    await new Promise(r => setTimeout(r, 0))
    expect(kept.get('legacy')?.size).toBe(3)
    expect(m.file('legacy')?.data).toBeUndefined()
    expect([...new Uint8Array(await ((await m.blob('legacy')) as Blob).arrayBuffer())]).toEqual([
      1, 2, 3,
    ])
    const purge = (m as unknown as { purgeTimer: ReturnType<typeof setInterval> }).purgeTimer
    clearInterval(purge)
  })
})

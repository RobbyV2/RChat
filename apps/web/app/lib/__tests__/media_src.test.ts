import { describe, expect, test } from 'bun:test'
import { MEDIA_CACHE_BYTES, blobCache, mediaMode } from '../media_src'

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0])

const setup = (keep: number, bytes = Infinity) => {
  const revoked: string[] = []
  const signals = new Map<string, AbortSignal>()
  const pending = new Map<string, (b: Blob) => void>()
  const cache = blobCache(keep, bytes, url => revoked.push(url))
  const load = (id: string, signal: AbortSignal) => {
    signals.set(id, signal)
    return new Promise<Blob>((resolve, reject) => {
      pending.set(id, resolve)
      signal.addEventListener('abort', () => reject(new Error('aborted')))
    })
  }
  // A PNG of `size` bytes (at least the 12-byte header).
  const finish = async (id: string, size = PNG.length) => {
    pending.get(id)?.(new Blob([PNG, new Uint8Array(Math.max(0, size - PNG.length))]))
    await new Promise(r => setTimeout(r, 0))
  }
  return { cache, load, revoked, signals, finish }
}

describe('guest media cache', () => {
  test('entries still mounted are never revoked past the cap', async () => {
    const { cache, load, revoked, finish } = setup(1)
    const a = cache.acquire('a', load)
    await finish('a')
    const b = cache.acquire('b', load)
    await finish('b')
    expect(cache.size()).toBe(2)
    expect(revoked).toEqual([])
    const url = await a.url
    a.release()
    expect(revoked).toEqual([url!])
    expect(cache.size()).toBe(1)
    b.release()
    expect(revoked.length).toBe(1)
  })

  test('two users share one load; it is revoked only once both left and the cap is hit', async () => {
    const { cache, load, revoked, finish } = setup(0)
    const a1 = cache.acquire('a', load)
    const a2 = cache.acquire('a', load)
    await finish('a')
    expect(await a1.url).toBe(await a2.url)
    a1.release()
    a1.release()
    expect(revoked).toEqual([])
    a2.release()
    expect(revoked).toEqual([(await a2.url)!])
  })

  test('the load is aborted when the last user unmounts before it finished', async () => {
    const { cache, load, signals } = setup(10)
    const a1 = cache.acquire('a', load)
    const a2 = cache.acquire('a', load)
    a1.release()
    expect(signals.get('a')?.aborted).toBe(false)
    a2.release()
    expect(signals.get('a')?.aborted).toBe(true)
    expect(cache.size()).toBe(0)
    expect(await a2.url.catch(() => 'failed')).toBe('failed')
  })

  test('unused images are revoked, least recently used first, while their bytes pass the budget', async () => {
    const { cache, load, revoked, finish } = setup(10, 100)
    const shown = async (id: string, size: number) => {
      const h = cache.acquire(id, load)
      await finish(id, size)
      return h
    }
    const a = await shown('a', 40)
    const b = await shown('b', 40)
    const urlA = (await a.url)!
    const urlB = (await b.url)!
    a.release()
    b.release()
    expect([cache.size(), cache.bytes(), revoked]).toEqual([2, 80, []])
    const again = cache.acquire('a', load)
    expect(await again.url).toBe(urlA)
    again.release()
    const c = await shown('c', 40)
    expect([cache.size(), cache.bytes(), revoked]).toEqual([2, 80, [urlB]])
    c.release()
    const d = await shown('d', 90)
    expect(revoked).toEqual([urlB, urlA, (await c.url)!])
    expect([cache.size(), cache.bytes()]).toEqual([1, 90])
    d.release()
    expect([cache.size(), cache.bytes()]).toEqual([1, 90])
  })

  test('an image in use stays past the byte budget until it is released', async () => {
    const { cache, load, revoked, finish } = setup(10, 50)
    const big = cache.acquire('big', load)
    await finish('big', 80)
    const url = await big.url
    expect([cache.size(), cache.bytes(), revoked]).toEqual([1, 80, []])
    big.release()
    expect([cache.size(), cache.bytes(), revoked]).toEqual([0, 0, [url!]])
  })

  test('the shared cache keeps at most 64 MiB of images', () => {
    expect(MEDIA_CACHE_BYTES).toBe(64 * 1024 * 1024)
  })

  test('clear aborts loads and revokes loaded URLs', async () => {
    const { cache, load, revoked, signals, finish } = setup(10)
    const a = cache.acquire('a', load)
    await finish('a')
    cache.acquire('b', load)
    cache.clear()
    expect(revoked).toEqual([(await a.url)!])
    expect(signals.get('b')?.aborted).toBe(true)
    expect([cache.size(), cache.bytes()]).toEqual([0, 0])
  })
})

describe('how media loads', () => {
  const PAGE = 'https://chat.a.com'
  const OTHER = 'https://chat.b.com'

  test("an account on the page's own API loads media by URL", () => {
    expect(mediaMode(PAGE, PAGE, true, false)).toBe('url')
    expect(mediaMode(PAGE, PAGE, true, true)).toBe('url')
  })

  test('an account on an API at another origin loads media through fetch', () => {
    expect(mediaMode(OTHER, PAGE, true, false)).toBe('blob')
    expect(mediaMode('http://127.0.0.1:3673', 'http://127.0.0.1:3670', true, false)).toBe('blob')
    expect(mediaMode('https://api.a.com', PAGE, true, false)).toBe('blob')
    expect(mediaMode(OTHER, 'tauri://localhost', true, false)).toBe('blob')
  })

  test('a guest with a grant loads media through fetch on any origin', () => {
    expect(mediaMode(PAGE, PAGE, false, true)).toBe('blob')
    expect(mediaMode(OTHER, PAGE, false, true)).toBe('blob')
  })

  test('public media without a token or grant loads by URL', () => {
    expect(mediaMode(PAGE, PAGE, false, false)).toBe('url')
    expect(mediaMode(OTHER, PAGE, false, false)).toBe('url')
  })
})

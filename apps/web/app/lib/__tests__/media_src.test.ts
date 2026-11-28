import { flush } from './helpers/test_clock'
import { describe, expect, test } from 'bun:test'
import { MEDIA_CACHE_BYTES, blobCache, mediaMode, shownBlob } from '../media_src'

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0])
const MP4 = new Uint8Array([0, 0, 0, 0x18, ...Array.from('ftypisom', c => c.charCodeAt(0))])

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
  // A PNG (or `head`) of `size` bytes, at least its header.
  const finish = async (id: string, size = PNG.length, head = PNG) => {
    pending.get(id)?.(new Blob([head, new Uint8Array(Math.max(0, size - head.length))]))
    await flush()
  }
  return { cache, load, revoked, signals, finish }
}

describe('guest media cache', () => {
  test('mounted entries are never revoked past the cap', async () => {
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

  test('a video gets a typed URL only where a video is asked for, and an image only as an image', async () => {
    const revoked: string[] = []
    const cache = blobCache(10, Infinity, url => revoked.push(url))
    const MP4 = new Uint8Array([0, 0, 0, 0x18, ...Array.from('ftypisom', c => c.charCodeAt(0))])
    const types: string[] = []
    const made = URL.createObjectURL
    URL.createObjectURL = (b: Blob) => (types.push(b.type), made(b))
    try {
      const of = (bytes: Uint8Array<ArrayBuffer>) => () => Promise.resolve(new Blob([bytes]))
      const video = cache.acquire('v', of(MP4), 'video')
      const asImage = cache.acquire('v-image', of(MP4))
      const pngAsVideo = cache.acquire('p-video', of(PNG), 'video')
      expect(typeof (await video.url)).toBe('string')
      expect(await asImage.url).toBeNull()
      expect(await pngAsVideo.url).toBeNull()
      expect(types).toEqual(['video/mp4'])
      expect(cache.bytes()).toBe(MP4.length)
      video.release()
      asImage.release()
      pngAsVideo.release()
      expect(revoked).toEqual([])
    } finally {
      URL.createObjectURL = made
    }
  })

  test('videos in use hold at most the byte budget together; one past it waits for room', async () => {
    const { cache, load, signals, finish } = setup(10, 100)
    const a = cache.acquire('a', load, 'video', 60)
    const b = cache.acquire('b', load, 'video', 60)
    const image = cache.acquire('i', load)
    expect([signals.has('a'), signals.has('b'), signals.has('i')]).toEqual([true, false, true])
    await finish('a', 60, MP4)
    expect(typeof (await a.url)).toBe('string')
    expect(signals.has('b')).toBe(false)
    a.release()
    expect(signals.has('b')).toBe(true)
    await finish('b', 60, MP4)
    expect(typeof (await b.url)).toBe('string')
    b.release()
    image.release()
  })

  test('a video whose bytes are no video frees its room', async () => {
    const { cache, load, signals, finish } = setup(10, 100)
    const a = cache.acquire('a', load, 'video', 60)
    const b = cache.acquire('b', load, 'video', 60)
    await finish('a', 60, PNG)
    expect(await a.url).toBeNull()
    expect(signals.has('b')).toBe(true)
    a.release()
    b.release()
  })

  test('a waiting video released before its turn never loads', async () => {
    const { cache, load, signals } = setup(10, 100)
    const a = cache.acquire('a', load, 'video', 60)
    const b = cache.acquire('b', load, 'video', 60)
    b.release()
    expect(await b.url).toBeNull()
    a.release()
    expect(signals.has('b')).toBe(false)
    expect(cache.size()).toBe(0)
  })

  test('a video on screen starts before older ones that wait', async () => {
    const { cache, load, signals, finish } = setup(10, 100)
    const a = cache.acquire('a', load, 'video', 60)
    const b = cache.acquire('b', load, 'video', 60)
    const c = cache.acquire('c', load, 'video', 60)
    cache.urge('c', true)
    expect([signals.has('b'), signals.has('c')]).toEqual([false, false])
    await finish('a', 60, MP4)
    a.release()
    expect([signals.has('b'), signals.has('c')]).toEqual([false, true])
    b.release()
    c.release()
  })

  test('a video evicted while away loads again under a new URL, the old one revoked', async () => {
    const { cache, load, revoked, finish } = setup(1)
    const first = cache.acquire('a', load, 'video', 20)
    await finish('a', 20, MP4)
    const old = (await first.url)!
    first.release()
    const other = cache.acquire('b', load, 'video', 20)
    await finish('b', 20, MP4)
    expect(revoked).toEqual([old])
    expect(cache.peek('a')).toBeUndefined()
    const again = cache.acquire('a', load, 'video', 20)
    await finish('a', 20, MP4)
    const fresh = (await again.url)!
    expect(fresh === old).toBe(false)
    expect(cache.peek('a')).toBe(fresh)
    expect(shownBlob(cache.peek('a'), fresh)).toBe(fresh)
    again.release()
    other.release()
  })

  test('only a URL the component holds is shown, never one the cache only knows of', () => {
    expect(shownBlob('blob:cached', undefined)).toBeUndefined()
    expect(shownBlob('blob:cached', 'blob:cached')).toBe('blob:cached')
    expect(shownBlob(undefined, undefined)).toBeUndefined()
    expect(shownBlob(undefined, null)).toBeNull()
    expect(shownBlob(null, undefined)).toBeNull()
  })

  test('an entry that is held stays through a trim; one only peeked at may go', async () => {
    const { cache, load, revoked, finish } = setup(1)
    const shown = cache.acquire('shown', load, 'video', 20)
    await finish('shown', 20, MP4)
    const url = (await shown.url)!
    shown.release()
    expect(cache.peek('shown')).toBe(url)
    const other = cache.acquire('other', load, 'video', 20)
    await finish('other', 20, MP4)
    expect(revoked).toEqual([url])
    const held = cache.acquire('other', load, 'video', 20)
    const third = cache.acquire('third', load, 'video', 20)
    await finish('third', 20, MP4)
    expect(revoked).toEqual([url])
    held.release()
    other.release()
    third.release()
  })

  test('a loaded entry can be read without taking it', async () => {
    const { cache, load, finish } = setup(10)
    const video = cache.acquire('v', load, 'video', 20)
    const notVideo = cache.acquire('n', load, 'video', 20)
    expect([cache.peek('v'), cache.peek('n'), cache.peek('none')]).toEqual([
      undefined,
      undefined,
      undefined,
    ])
    await finish('v', 20, MP4)
    await finish('n', 20, PNG)
    expect(cache.peek('v')).toBe((await video.url)!)
    expect(cache.peek('n')).toBeNull()
    video.release()
    notVideo.release()
  })

  test('the shared cache keeps at most 64 MiB of images and videos', () => {
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

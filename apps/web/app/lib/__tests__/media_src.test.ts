import { describe, expect, test } from 'bun:test'
import { blobCache } from '../media_src'

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0])

const setup = (keep: number) => {
  const revoked: string[] = []
  const signals = new Map<string, AbortSignal>()
  const pending = new Map<string, (b: Blob) => void>()
  const cache = blobCache(keep, url => revoked.push(url))
  const load = (id: string, signal: AbortSignal) => {
    signals.set(id, signal)
    return new Promise<Blob>((resolve, reject) => {
      pending.set(id, resolve)
      signal.addEventListener('abort', () => reject(new Error('aborted')))
    })
  }
  const finish = async (id: string) => {
    pending.get(id)?.(new Blob([PNG]))
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

  test('clear aborts loads and revokes loaded URLs', async () => {
    const { cache, load, revoked, signals, finish } = setup(10)
    const a = cache.acquire('a', load)
    await finish('a')
    cache.acquire('b', load)
    cache.clear()
    expect(revoked).toEqual([(await a.url)!])
    expect(signals.get('b')?.aborted).toBe(true)
    expect(cache.size()).toBe(0)
  })
})

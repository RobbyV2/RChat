import { afterEach, describe, expect, test } from 'bun:test'
import { p2p, servable, type StoredFile } from '../p2p'

const file = (expires_at: number | null): StoredFile => ({
  name: 'a.txt',
  mime: 'text/plain',
  size: 1,
  data: 'YQ==',
  expires_at,
})

describe('p2p serving', () => {
  test('never serves missing or expired files', () => {
    expect(servable(null, 100)).toBeNull()
    expect(servable(file(100), 100)).toBeNull()
    expect(servable(file(101), 100)?.name).toBe('a.txt')
    expect(servable(file(null), 100)?.name).toBe('a.txt')
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

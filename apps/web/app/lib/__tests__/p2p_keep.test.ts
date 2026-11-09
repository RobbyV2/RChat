import { describe, expect, test } from 'bun:test'
import { KEEP_ASKED, keepAsker } from '../p2p/keep'
import type { StorageLike } from '../instances'

// Firefox answers navigator.storage.persist() only through its prompt; a dismissed prompt is
// asked again at a later P2P start, once per tab session, and nothing ever waits for it.

const session = (): StorageLike & { items: Map<string, string> } => {
  const items = new Map<string, string>()
  return {
    items,
    getItem: k => items.get(k) ?? null,
    setItem: (k, v) => void items.set(k, v),
    removeItem: k => void items.delete(k),
  }
}

const browser = (kept: boolean) => {
  const s = { asked: 0, kept }
  return {
    s,
    storage: {
      persisted: async () => s.kept,
      persist: () => {
        s.asked += 1
        return new Promise<boolean>(() => {})
      },
    },
  }
}

describe('keeping P2P data', () => {
  test('asks once per tab session while the data is not kept, without waiting', async () => {
    const tab = session()
    const { s, storage } = browser(false)
    const ask = keepAsker(() => tab)
    await ask(storage)
    await ask(storage)
    expect(s.asked).toBe(1)
    expect(tab.items.get(KEEP_ASKED)).toBe('1')
    // A reload in the same tab.
    await keepAsker(() => tab)(storage)
    expect(s.asked).toBe(1)
    // A new tab session.
    await keepAsker(() => session())(storage)
    expect(s.asked).toBe(2)
  })

  test('kept data is not asked about', async () => {
    const { s, storage } = browser(true)
    await keepAsker(() => session())(storage)
    expect(s.asked).toBe(0)
  })

  test('no storage API or no session storage is fine', async () => {
    await keepAsker(() => session())(undefined)
    const { s, storage } = browser(false)
    const ask = keepAsker(() => {
      throw new Error('blocked')
    })
    await ask(storage)
    await ask(storage)
    expect(s.asked).toBe(1)
  })
})

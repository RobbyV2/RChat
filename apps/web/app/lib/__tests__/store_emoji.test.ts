import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { useStore } from '../store'
import { EMPTY_PREFS, parseEmojiPrefs, topEmojis } from '../emoji'
import { me, memoryStorage } from './fixtures'

const st = () => useStore.getState()
const storage = new Map<string, string>()

beforeEach(() => {
  storage.clear()
  Object.assign(globalThis, {
    localStorage: {
      getItem: (k: string) => storage.get(k) ?? null,
      setItem: (k: string, v: string) => void storage.set(k, v),
      removeItem: (k: string) => void storage.delete(k),
    },
  })
  useStore.setState({ me: me('alice'), guest: false, emoji: EMPTY_PREFS })
})

afterEach(() => {
  Object.assign(globalThis, { localStorage: memoryStorage })
})

describe('emoji prefs in the store', () => {
  test('picks and the skin tone persist under the account key', () => {
    st().noteEmoji('👋', '👋🏽')
    st().setSkinTone(3)
    const saved = parseEmojiPrefs(storage.get('rchat_emoji:alice') ?? null)
    expect(saved.tone).toBe(3)
    expect(saved.used['👋']?.last).toBe('👋🏽')
    expect(topEmojis(3, st().emoji)).toEqual(['👋🏽', '👍', '😂'])
  })

  test('guests and signed out sessions never write', () => {
    useStore.setState({ me: null, guest: true })
    st().noteEmoji('👋', '👋')
    st().setSkinTone(2)
    expect(storage.size).toBe(0)
    expect(st().emoji).toEqual(EMPTY_PREFS)
  })

  test('reloadEmoji picks up another tab and ignores bad data', () => {
    storage.set('rchat_emoji:alice', JSON.stringify({ v: 1, tone: 5, used: {} }))
    st().reloadEmoji()
    expect(st().emoji.tone).toBe(5)
    storage.set('rchat_emoji:alice', '{oops')
    st().reloadEmoji()
    expect(st().emoji).toEqual(EMPTY_PREFS)
  })
})

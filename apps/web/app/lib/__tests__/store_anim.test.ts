import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { useStore, resetSessionCaches } from '../store'
import { ANIM_DEFAULT } from '../motion/setting'
import { me, memoryStorage } from './fixtures'

afterAll(resetSessionCaches)

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
  useStore.setState({ me: me('alice'), guest: false, anim: ANIM_DEFAULT })
})

afterEach(() => {
  Object.assign(globalThis, { localStorage: memoryStorage })
  useStore.setState({ me: null, guest: false, anim: ANIM_DEFAULT })
})

describe('the Animations setting in the store', () => {
  test('starts off and is saved per account', () => {
    expect(st().anim).toEqual({ on: false, motion: 'device' })
    st().setAnim({ on: true, motion: 'always' })
    expect(st().anim).toEqual({ on: true, motion: 'always' })
    expect(storage.get('rchat_anim:alice')).toBe('{"v":1,"on":true,"motion":"always"}')
  })

  test('another tab changing it reloads it, and junk reads as the default', () => {
    storage.set('rchat_anim:alice', '{"v":1,"on":true,"motion":"still"}')
    st().reloadAnim()
    expect(st().anim).toEqual({ on: true, motion: 'still' })
    storage.set('rchat_anim:alice', '{not json')
    st().reloadAnim()
    expect(st().anim).toEqual(ANIM_DEFAULT)
  })

  test('guests keep their own, and nobody signed in saves nothing', () => {
    useStore.setState({ me: null, guest: true })
    st().setAnim({ on: true, motion: 'device' })
    expect(storage.get('rchat_anim:guest')).toBe('{"v":1,"on":true,"motion":"device"}')
    useStore.setState({ me: null, guest: false, anim: ANIM_DEFAULT })
    st().setAnim({ on: true, motion: 'device' })
    expect([...storage.keys()]).toEqual(['rchat_anim:guest'])
  })

  test('an imported config sets it', async () => {
    const doc = { v: 1 as const, animations: { on: true, motion: 'still' as const } }
    expect(await st().applyConfig(doc, ['animations'])).toBeNull()
    expect(st().anim).toEqual({ on: true, motion: 'still' })
    expect(storage.get('rchat_anim:alice')).toBe('{"v":1,"on":true,"motion":"still"}')
  })
})

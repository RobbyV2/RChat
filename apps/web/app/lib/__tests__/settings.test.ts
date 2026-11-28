import { afterEach, describe, expect, test } from 'bun:test'
import { bool, choice, obj } from '../schema'
import { defineSetting, readLocal, versioned, writeLocal } from '../settings'

const real = globalThis.localStorage
const use = (store: Partial<Storage>) =>
  Object.defineProperty(globalThis, 'localStorage', { value: store, configurable: true })
afterEach(() => {
  Object.defineProperty(globalThis, 'localStorage', { value: real, configurable: true })
})

const memory = () => {
  const kept = new Map<string, string>()
  use({
    getItem: key => kept.get(key) ?? null,
    setItem: (key, value) => void kept.set(key, value),
    removeItem: key => void kept.delete(key),
  })
  return kept
}

const typing = defineSetting<boolean, [string | null]>({
  scope: 'account',
  key: owner => `test_typing:${owner ?? 'guest'}`,
  ...versioned(
    1,
    obj({ on: bool }).map(r => r.on),
    on => ({ on }),
    true
  ),
})
const look = defineSetting<'dark' | 'light'>({
  scope: 'device',
  key: () => 'test_look',
  ...versioned(
    2,
    obj({ look: choice('dark', 'light') }).map(r => r.look),
    value => ({ look: value }),
    'dark'
  ),
})

const own = { scoped: (key: string) => key }
const other = { scoped: (key: string) => `${key}@chat.example` }

describe('a defined setting', () => {
  test('is kept per account under the key its instance gives', () => {
    const kept = memory()
    expect(typing.read(own, 'ann')).toBe(true)
    expect(typing.write(own, false, 'ann')).toBe(true)
    expect(typing.write(other, false, null)).toBe(true)
    expect([...kept]).toEqual([
      ['test_typing:ann', '{"v":1,"on":false}'],
      ['test_typing:guest@chat.example', '{"v":1,"on":false}'],
    ])
    expect(typing.read(own, 'ann')).toBe(false)
    expect(typing.read(own, 'bob')).toBe(true)
    expect(typing.key(other, 'ann')).toBe('test_typing:ann@chat.example')
    expect(typing.clear(own, 'ann')).toBe(true)
    expect(typing.read(own, 'ann')).toBe(true)
  })

  test('is kept once for the device when its scope says so', () => {
    const kept = memory()
    expect(look.read()).toBe('dark')
    look.write('light')
    expect([...kept]).toEqual([['test_look', '{"v":2,"look":"light"}']])
    expect(look.read()).toBe('light')
  })

  test('reads its fallback from anything it cannot read', () => {
    const kept = memory()
    for (const text of [
      'not json',
      'null',
      '[]',
      '{"on":false}',
      '{"v":2,"on":false}',
      '{"v":1,"on":"no"}',
      '{"v":1}',
    ]) {
      kept.set('test_typing:ann', text)
      expect([text, typing.read(own, 'ann')]).toEqual([text, true])
    }
    kept.set('test_typing:ann', '{"v":1,"on":false,"later":7}')
    expect(typing.read(own, 'ann')).toBe(false)
  })

  test('reads its fallback and refuses the write when the storage throws', () => {
    const broken = () => {
      throw new Error('blocked')
    }
    use({ getItem: broken, setItem: broken, removeItem: broken })
    expect(typing.read(own, 'ann')).toBe(true)
    expect(typing.write(own, false, 'ann')).toBe(false)
    expect(typing.clear(own, 'ann')).toBe(false)
    expect(readLocal('anything')).toBeNull()
    expect(writeLocal('anything', '1')).toBe(false)
  })

  test('reads its fallback where there is no storage at all', () => {
    Object.defineProperty(globalThis, 'localStorage', { value: undefined, configurable: true })
    expect(look.read()).toBe('dark')
    expect(look.write('light')).toBe(true)
  })
})

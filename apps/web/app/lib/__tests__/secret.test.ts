import { describe, expect, test } from 'bun:test'
import { inspect } from 'node:util'
import { sameSecret, Secret, Sink, TO_CRYPTO, TO_REQUEST, TO_SCREEN, TO_STORE } from '../secret'

describe('Secret', () => {
  test('a sink gives the value back', () => {
    const token = Secret.of('tok-1')
    for (const sink of [TO_REQUEST, TO_STORE, TO_CRYPTO, TO_SCREEN])
      expect(token.reveal(sink)).toBe('tok-1')
  })

  test('nothing but a sink reveals it', () => {
    const token = Secret.of('tok-1')
    const reveal = token.reveal.bind(token) as (sink: unknown) => string
    expect(() => reveal(undefined)).toThrow()
    expect(() => reveal({ name: 'request' })).toThrow()
    const Raw = Sink as unknown as new (key: symbol, name: string) => Sink
    expect(() => new Raw(Symbol('secret'), 'request')).toThrow()
  })

  test('it cannot be written into JSON', () => {
    const token = Secret.of('tok-1')
    expect(() => JSON.stringify(token)).toThrow()
    expect(() => JSON.stringify({ auth: { token } })).toThrow()
    expect(() => JSON.stringify([token])).toThrow()
  })

  test('text built from it never holds the value', () => {
    const token = Secret.of('tok-1')
    expect(String(token)).toBe('[secret]')
    expect(`Bearer ${token}`).toBe('Bearer [secret]')
    expect('' + token).toBe('[secret]')
    expect(inspect(token)).not.toContain('tok-1')
    expect(inspect({ token })).not.toContain('tok-1')
  })

  test('its value is not a field of the object', () => {
    const token = Secret.of('tok-1')
    expect(Object.keys(token)).toEqual([])
    expect(Object.getOwnPropertyNames(token)).toEqual([])
    expect(Object.values({ ...token })).toEqual([])
  })

  test('it cannot be built without the wrapper', () => {
    const Raw = Secret as unknown as new (key: symbol, value: string) => Secret
    expect(() => new Raw(Symbol('secret'), 'x')).toThrow()
  })

  test('from treats a missing or empty value as absent', () => {
    expect(Secret.from(null)).toBeNull()
    expect(Secret.from(undefined)).toBeNull()
    expect(Secret.from('')).toBeNull()
    expect(Secret.from(new Uint8Array())).toBeNull()
    expect(Secret.from('a')?.reveal(TO_STORE)).toBe('a')
  })

  test('same compares values, for text and for bytes', () => {
    expect(Secret.of('a').same(Secret.of('a'))).toBe(true)
    expect(Secret.of('a').same(Secret.of('b'))).toBe(false)
    expect(Secret.of('a').same(null)).toBe(false)
    const key = Secret.of(new Uint8Array([1, 2, 3]))
    expect(key.same(Secret.of(new Uint8Array([1, 2, 3])))).toBe(true)
    expect(key.same(Secret.of(new Uint8Array([1, 2, 4])))).toBe(false)
    expect(key.same(Secret.of(new Uint8Array([1, 2])))).toBe(false)
  })

  test('sameSecret treats two absent secrets as the same', () => {
    expect(sameSecret(null, undefined)).toBe(true)
    expect(sameSecret(Secret.of('a'), null)).toBe(false)
    expect(sameSecret(null, Secret.of('a'))).toBe(false)
    expect(sameSecret(Secret.of('a'), Secret.of('a'))).toBe(true)
  })
})

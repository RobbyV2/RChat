import { describe, expect, test } from 'bun:test'
import { resolveApiBase } from '../api'
import { wsUrlFrom } from '../ws'

describe('resolveApiBase', () => {
  test('NEXT_PUBLIC_API_URL set, trailing slashes stripped', () => {
    expect(resolveApiBase('https://x.com//', false)).toBe('https://x.com/api')
  })

  test('url wins over window', () => {
    expect(resolveApiBase('https://x.com', true)).toBe('https://x.com/api')
  })

  test('unset with window -> relative', () => {
    expect(resolveApiBase(undefined, true)).toBe('/api')
  })

  test('unset without window -> host/port', () => {
    expect(resolveApiBase(undefined, false, 'srv', '9000')).toBe('http://srv:9000/api')
  })

  test('unset without window, no host/port -> defaults', () => {
    expect(resolveApiBase(undefined, false)).toBe('http://127.0.0.1:3000/api')
    expect(resolveApiBase(undefined, false, '', '')).toBe('http://127.0.0.1:3000/api')
  })
})

describe('wsUrlFrom', () => {
  test('https api base -> wss', () => {
    expect(wsUrlFrom('https://x.com')).toBe('wss://x.com/api/ws')
  })

  test('http api base with port -> ws', () => {
    expect(wsUrlFrom('http://x.com:3000')).toBe('ws://x.com:3000/api/ws')
  })

  test('no api base derives from location + basePath', () => {
    expect(wsUrlFrom(undefined, { protocol: 'https:', host: 'h:1' }, '/base')).toBe(
      'wss://h:1/base/api/ws'
    )
    expect(wsUrlFrom(undefined, { protocol: 'http:', host: 'h' })).toBe('ws://h/api/ws')
  })
})

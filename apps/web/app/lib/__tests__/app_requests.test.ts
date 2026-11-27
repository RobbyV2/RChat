import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { askApp, takeAppRequest } from '../app_requests'

const real = Object.getOwnPropertyDescriptor(globalThis, 'window')
let storage: Map<string, string>

beforeEach(() => {
  storage = new Map()
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      sessionStorage: {
        getItem: (k: string) => storage.get(k) ?? null,
        setItem: (k: string, v: string) => storage.set(k, v),
        removeItem: (k: string) => storage.delete(k),
      },
    },
  })
})

afterEach(() => {
  if (real) Object.defineProperty(globalThis, 'window', real)
  else Reflect.deleteProperty(globalThis, 'window')
})

describe('app requests', () => {
  test('a request is taken once', () => {
    expect(takeAppRequest()).toBeNull()
    askApp('add_instance')
    expect(takeAppRequest()).toBe('add_instance')
    expect(takeAppRequest()).toBeNull()
  })

  test('an unknown request is cleared and ignored', () => {
    storage.set('rchat_app_request', 'format_disk')
    expect(takeAppRequest()).toBeNull()
    expect(storage.size).toBe(0)
  })
})

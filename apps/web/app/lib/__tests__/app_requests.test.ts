import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { answerAppRequests, askApp, askAppWindow, takeAppRequest } from '../app_requests'
import { testClock } from './helpers/test_clock'

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

describe('app requests across windows', () => {
  test("the main window takes another window's request and says so", async () => {
    const taken: string[] = []
    const stop = answerAppRequests(r => taken.push(r))
    try {
      expect(await askAppWindow('add_instance')).toBe(true)
      expect(taken).toEqual(['add_instance'])
    } finally {
      stop()
    }
  })

  test('requests it does not know go unanswered', async () => {
    const taken: string[] = []
    const stop = answerAppRequests(r => taken.push(r))
    const other = new BroadcastChannel('rchat_app_requests')
    const answers: unknown[] = []
    other.onmessage = e => answers.push(e.data)
    other.postMessage({ request: 'format_disk', id: 'x' })
    expect(await askAppWindow('add_instance')).toBe(true)
    other.close()
    stop()
    expect(taken).toEqual(['add_instance'])
    expect(answers.some(a => (a as { taken?: string }).taken === 'x')).toBe(false)
  })

  test('with no main window to answer, the ask gives up after half a second', async () => {
    const clock = testClock()
    const asked = askAppWindow('add_instance')
    clock.advance(499)
    expect(clock.pending).toBe(1)
    clock.advance(1)
    expect(await asked).toBe(false)
  })
})

import { testClock, type ManualTime } from './helpers/test_clock'
import { expect, test, beforeEach } from 'bun:test'
import { watchIncomingShares } from '../platform/incoming_share'
import type { SharedContent } from '../client/share_target'
import type { Invoke } from '../platform/desktop'

let clock: ManualTime
beforeEach(() => {
  clock = testClock()
})

test('mobile startup and live deliveries consume once, with bounded native errors and stale results discarded', async () => {
  const w = new EventTarget(),
    doc = Object.assign(new EventTarget(), { hidden: false })
  const oldWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
  const oldDocument = Object.getOwnPropertyDescriptor(globalThis, 'document')
  Object.defineProperty(globalThis, 'window', { configurable: true, value: w })
  Object.defineProperty(globalThis, 'document', { configurable: true, value: doc })
  const pending: ReturnType<typeof Promise.withResolvers<unknown>>[] = []
  const delivered: SharedContent[] = [],
    errors: string[] = []
  let rev = 0
  const stop = watchIncomingShares(
    (async (command: string) => {
      expect(command).toBe('take_incoming_share')
      const req = Promise.withResolvers<unknown>()
      pending.push(req)
      return req.promise
    }) as Invoke,
    p => delivered.push(p),
    e => errors.push(e),
    () => rev
  )
  const next = () => clock.pass(5)
  try {
    await next()
    w.dispatchEvent(new Event('rchat-incoming-share'))
    expect(pending.length).toBe(1)
    pending[0].resolve({
      text: 'First',
      files: [{ name: 'Folder/test.txt', mime: 'text/plain', data: btoa('content') }],
    })
    await next()
    expect(delivered[0].text).toBe('First')
    expect(delivered[0].files[0].name).toBe('test.txt')
    expect(await delivered[0].files[0].text()).toBe('content')
    rev++
    pending[1].resolve({ text: 'late', files: [] })
    await next()
    expect(delivered.length).toBe(1)
    w.dispatchEvent(new Event('focus'))
    pending[2].resolve({ text: '', files: [], error: 'Size limit' })
    await next()
    expect(errors).toEqual(['Size limit'])
    w.dispatchEvent(new Event('focus'))
    rev++
    pending[3].reject(new Error('Earlier take failed'))
    await next()
    expect(errors).toEqual(['Size limit'])
    w.dispatchEvent(new Event('focus'))
    stop()
    pending[4].resolve({ text: 'after teardown', files: [] })
    w.dispatchEvent(new Event('rchat-incoming-share'))
    await next()
    expect(pending.length).toBe(5)
    expect(delivered.length).toBe(1)
  } finally {
    stop()
    if (oldWindow) Object.defineProperty(globalThis, 'window', oldWindow)
    else Reflect.deleteProperty(globalThis, 'window')
    if (oldDocument) Object.defineProperty(globalThis, 'document', oldDocument)
    else Reflect.deleteProperty(globalThis, 'document')
  }
})

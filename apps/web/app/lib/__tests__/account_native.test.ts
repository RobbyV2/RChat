import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { expect, test } from 'bun:test'
import { listenForLinks } from '../../components/desktop_bridge'
import { handleAndroidBack } from '../../components/mobile_bridge'
import { client } from '../client/client'
import { testAccount } from './test_account'

function replaceGlobal(key: string, value: unknown) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, key)
  Object.defineProperty(globalThis, key, { value, configurable: true })
  return () => {
    if (previous) Object.defineProperty(globalThis, key, previous)
    else Reflect.deleteProperty(globalThis, key)
  }
}

for (const change of ['switch', 'sign out']) {
  test(`startup links retain the pre-registration owner across a ${change}`, async () => {
    const a = testAccount('reader')
    const b = testAccount('reader')
    const previous = client.shown
    const restoreWindow = replaceGlobal('window', { location: { pathname: '/' } })
    try {
      client.shown = () => a
      const registration = Promise.withResolvers<() => void>()
      let event!: () => void
      const failures: string[] = []
      a.store.setState({ setError: () => void failures.push('a') })
      b.store.setState({ setError: () => void failures.push('b') })
      const listener = listenForLinks(
        async () => false,
        () => true,
        (_, callback) => {
          event = callback
          return registration.promise
        },
        async () => ['invalid']
      )
      if (change === 'switch') client.shown = () => b
      else a.lifetime.endSession()
      registration.resolve(() => {})
      await listener
      await new Promise(resolve => setTimeout(resolve, 0))
      expect(failures).toEqual([])
      event()
      await new Promise(resolve => setTimeout(resolve, 0))
      expect(failures).toEqual([change === 'switch' ? 'b' : 'a'])
    } finally {
      restoreWindow()
      client.shown = previous
      a.store.dispose()
      b.store.dispose()
    }
  })
}

for (const switched of [false, true]) {
  test(`startup and an overlapping native wake open their owner's links in order (switched: ${switched})`, async () => {
    const a = testAccount('reader')
    const b = testAccount('reader')
    const previous = client.shown
    const paths: string[] = []
    const restore = replaceGlobal('window', {
      location: { pathname: '/' },
      history: { pushState: (_: unknown, __: string, path: string) => paths.push(path) },
      dispatchEvent() {},
    })
    const restorePop = replaceGlobal('PopStateEvent', Event)
    try {
      client.shown = () => a
      const ready = Promise.withResolvers<() => void>()
      let event!: (batch?: number) => void
      const queue = new Map([
        [1, 'rchat://instance.test/dm/1/'],
        [2, 'rchat://instance.test/dm/2/'],
      ])
      const listener = listenForLinks(
        async () => false,
        () => true,
        (_, cb) => {
          event = cb
          return ready.promise
        },
        async batch => {
          const urls = []
          for (const [id, url] of queue) {
            if (batch !== undefined && batch !== id) continue
            urls.push(url)
            queue.delete(id)
          }
          return urls
        }
      )
      if (switched) client.shown = () => b
      event(2)
      ready.resolve(() => {})
      await listener
      await new Promise(resolve => setTimeout(resolve, 0))
      const prefix = '/@reader@instance.test'
      expect(paths).toEqual(
        (switched ? ['/dm/2/'] : ['/dm/1/', '/dm/2/']).map(path => prefix + path)
      )
      expect(queue.size).toBe(0)
    } finally {
      client.shown = previous
      restorePop()
      restore()
      a.store.dispose()
      b.store.dispose()
    }
  })
}

test('Android Back checks the shown and overlay lifetimes after two frames', async () => {
  const a = testAccount('reader')
  const b = testAccount('reader')
  const previous = client.shown
  const actions: string[] = []
  const frames: (() => void)[] = []
  const window = Object.assign(new EventTarget(), { history: { back: () => actions.push('back') } })
  const restore = [
    replaceGlobal('window', window),
    replaceGlobal('KeyboardEvent', Event),
    replaceGlobal('document', { querySelectorAll: () => [] }),
    replaceGlobal('requestAnimationFrame', (cb: () => void) => frames.push(cb)),
  ]
  try {
    client.shown = () => a
    b.store.setState({ activeDialog: { kind: 'settings' } })
    for (const back of [true, false]) {
      for (const account of [a, b]) {
        const pending = handleAndroidBack(
          back,
          () => true,
          () => void actions.push('exit')
        )
        frames.shift()!()
        account.lifetime.endSession()
        frames.shift()!()
        await pending
      }
    }
    expect(actions).toEqual([])
    const pending = handleAndroidBack(
      true,
      () => true,
      () => {}
    )
    frames.shift()!()
    frames.shift()!()
    await pending
    expect(actions).toEqual(['back'])
  } finally {
    for (const reset of restore) reset()
    client.shown = previous
    a.store.dispose()
    b.store.dispose()
  }
})

test('native save errors belong to the requesting account until its session ends', () => {
  const fixture = fileURLToPath(new URL('./fixtures/native_save_owner.ts', import.meta.url))
  const result = spawnSync(process.execPath, [fixture], { encoding: 'utf8' })
  expect([result.status, result.stderr]).toEqual([0, ''])
}, 60_000)

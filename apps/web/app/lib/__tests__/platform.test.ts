import { afterEach, describe, expect, test } from 'bun:test'
import { notifications, setNotifier, setSharing, sharing } from '../platform'
import { webSharing } from '../platform/web_sharing'
import { permissionOf } from '../platform/notifications'
import { webNotifier } from '../platform/web_notifications'
import { fakeNotifier } from './fake_notifier'

const g = globalThis as Record<string, unknown>
const saved = ['Notification', 'window', 'document', 'navigator'].map(k => [k, g[k]] as const)

afterEach(() => {
  for (const [k, v] of saved) g[k] = v
  setNotifier(webNotifier)
})

class FakeNotification {
  static permission: NotificationPermission = 'granted'
  static made: FakeNotification[] = []
  static requestPermission = async () => FakeNotification.permission
  onclick: (() => void) | null = null
  closed = false
  constructor(
    public title: string,
    public opts: NotificationOptions & { renotify?: boolean }
  ) {
    FakeNotification.made.push(this)
  }
  close() {
    this.closed = true
  }
}

const events = () => {
  const on = new Map<string, () => void>()
  return {
    on,
    addEventListener: (k: string, f: () => void) => void on.set(k, f),
    removeEventListener: (k: string) => void on.delete(k),
  }
}

describe('registry', () => {
  test('the web adapter by default; a registered one replaces it', () => {
    expect(notifications()).toBe(webNotifier)
    const fake = fakeNotifier('granted')
    setNotifier(fake)
    expect(notifications()).toBe(fake)
    notifications().show({ title: 't', body: 'b', tag: 'c1', onClick: () => {} })
    expect(fake.shown.map(n => n.tag)).toEqual(['c1'])
  })

  test('permission values are normalized', () => {
    expect(permissionOf('granted')).toBe('granted')
    expect(permissionOf('denied')).toBe('denied')
    expect(permissionOf('prompt')).toBe('default')
    expect(permissionOf(undefined)).toBe('default')
  })
})

describe('web adapter', () => {
  test('unsupported without the Notification API', async () => {
    delete g.Notification
    expect(webNotifier.supported()).toBe(false)
    expect(webNotifier.permission()).toBe('unsupported')
    expect(await webNotifier.requestPermission()).toBe('unsupported')
    expect(webNotifier.show({ title: 't', body: '', tag: 'x', onClick: () => {} })).toBeNull()
  })

  test('shows with tag and renotify; click focuses, closes and calls back', () => {
    g.Notification = FakeNotification
    FakeNotification.permission = 'granted'
    FakeNotification.made = []
    let focused = 0
    let clicked = 0
    g.window = { focus: () => void (focused += 1) }
    const handle = webNotifier.show({
      title: 'Alice',
      body: 'hi',
      tag: 'c1',
      renotify: true,
      onClick: () => void (clicked += 1),
    })
    const [n] = FakeNotification.made
    expect(n.title).toBe('Alice')
    expect(n.opts.tag).toBe('c1')
    expect(n.opts.renotify).toBe(true)
    n.onclick?.()
    expect([focused, clicked, n.closed]).toEqual([1, 1, true])
    handle?.close()
  })

  test('nothing is shown without permission', () => {
    g.Notification = FakeNotification
    FakeNotification.permission = 'denied'
    FakeNotification.made = []
    expect(webNotifier.permission()).toBe('denied')
    expect(webNotifier.show({ title: 't', body: '', tag: 'x', onClick: () => {} })).toBeNull()
    expect(FakeNotification.made).toEqual([])
  })

  test('a revoked permission is reported through the Permissions API', async () => {
    g.Notification = FakeNotification
    FakeNotification.permission = 'granted'
    const status = events()
    g.navigator = { permissions: { query: async () => status } }
    g.window = events()
    g.document = events()
    const seen: string[] = []
    const stop = webNotifier.onPermissionChange(p => void seen.push(p))
    await Promise.resolve()
    await Promise.resolve()
    FakeNotification.permission = 'denied'
    status.on.get('change')?.()
    status.on.get('change')?.()
    expect(seen).toEqual(['denied'])
    stop()
    expect(status.on.size).toBe(0)
  })

  test('badge: count on the tab title and the app icon', () => {
    const calls: string[] = []
    g.document = { title: 'RChat' }
    g.navigator = {
      setAppBadge: async (n: number) => void calls.push(`set ${n}`),
      clearAppBadge: async () => void calls.push('clear'),
    }
    webNotifier.setBadge(3)
    expect((g.document as { title: string }).title).toBe('(3) RChat')
    webNotifier.setBadge(0)
    expect((g.document as { title: string }).title).toBe('RChat')
    expect(calls).toEqual(['set 3', 'clear'])
  })
})

describe('sharing', () => {
  const nav = (over: Record<string, unknown>) =>
    Object.defineProperty(globalThis, 'navigator', { value: over, configurable: true })

  test('registry defaults to the web adapter and accepts another', () => {
    expect(sharing()).toBe(webSharing)
    const fake = { ...webSharing, canShare: () => true }
    setSharing(fake)
    expect(sharing()).toBe(fake)
    setSharing(webSharing)
  })

  test('web clipboard and share report what happened', async () => {
    const copied: string[] = []
    nav({ clipboard: { writeText: async (t: string) => void copied.push(t) } })
    expect(await webSharing.copyText('rc1.abc')).toBe(true)
    expect(copied).toEqual(['rc1.abc'])
    nav({})
    expect(await webSharing.copyText('x')).toBe(false)
    expect(webSharing.canShare()).toBe(false)
    expect(await webSharing.share({ url: 'http://x/config/a/' })).toBe('failed')
    nav({ clipboard: { writeText: async () => Promise.reject(new Error('denied')) } })
    expect(await webSharing.copyText('x')).toBe(false)
    const shared: unknown[] = []
    nav({ share: async (d: unknown) => void shared.push(d) })
    expect(webSharing.canShare()).toBe(true)
    expect(await webSharing.share({ url: 'http://x/config/a/' })).toBe('shared')
    expect(shared).toEqual([{ url: 'http://x/config/a/' }])
    nav({
      share: async () => Promise.reject(new DOMException('no', 'AbortError')),
    })
    expect(await webSharing.share({ url: 'u' })).toBe('cancelled')
  })
})

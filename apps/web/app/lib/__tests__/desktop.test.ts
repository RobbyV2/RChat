import { afterEach, describe, expect, test } from 'bun:test'
import {
  desktopInfo,
  inShell,
  mobileOs,
  shellInfo,
  shellOf,
  type Invoke,
} from '../platform/desktop'
import { mobileSharing, onBack, pressEscape, shareText, type BackEnv } from '../platform/mobile'
import { desktopNotifier } from '../platform/desktop_notifications'
import { CHUNK_BYTES, SAVE_FAILED, desktopSharing, saveTo } from '../platform/desktop_sharing'
import { confirmGate, deepLinkTarget, openDeepLink, type LinkEnv } from '../deep_links'
import { home, shareOrigin } from '../instances'

type Call = { cmd: string; args?: unknown; headers?: Record<string, string> }

const fakeInvoke = (answers: Record<string, (args: unknown) => unknown> = {}) => {
  const calls: Call[] = []
  const call: Invoke = async <T>(
    cmd: string,
    args?: unknown,
    options?: { headers: Record<string, string> }
  ) => {
    calls.push({ cmd, args, headers: options?.headers })
    const answer = answers[cmd]
    return (answer ? answer(args) : null) as T
  }
  return { call, calls }
}

const g = globalThis as Record<string, unknown>
const savedDocument = g.document

afterEach(() => {
  g.document = savedDocument
})

describe('desktop detection', () => {
  test('reads the shell info and rejects anything else', () => {
    expect(desktopInfo({ __RCHAT_DESKTOP__: { os: 'linux', version: '1.0.0' } })).toEqual({
      os: 'linux',
      version: '1.0.0',
    })
    expect(desktopInfo({})).toBeNull()
    expect(desktopInfo(undefined)).toBeNull()
    expect(desktopInfo({ __RCHAT_DESKTOP__: { os: 'beos', version: '1' } })).toBeNull()
    expect(desktopInfo({ __RCHAT_DESKTOP__: { os: 'macos' } })).toBeNull()
    expect(desktopInfo({ __RCHAT_DESKTOP__: 'windows' })).toBeNull()
  })

  test('mobile shells are shells but not desktops', () => {
    const android = { __RCHAT_DESKTOP__: { os: 'android', version: '1.0.0' } }
    expect(shellInfo(android)).toEqual({ os: 'android', version: '1.0.0' })
    expect(desktopInfo(android)).toBeNull()
    expect(mobileOs(android)).toBe('android')
    expect(mobileOs({ __RCHAT_DESKTOP__: { os: 'ios', version: '1' } })).toBe('ios')
    expect(mobileOs({ __RCHAT_DESKTOP__: { os: 'linux', version: '1' } })).toBeNull()
    expect(shellInfo({ __RCHAT_DESKTOP__: { os: 'linux', version: '1' } })?.os).toBe('linux')
    expect(inShell({ ...android, __TAURI_INTERNALS__: {} })).toBe(true)
  })

  test('native calls need the real shell, not just the flag', () => {
    const info = { os: 'windows', version: '1.0.0' }
    expect(inShell({ __RCHAT_DESKTOP__: info })).toBe(false)
    expect(inShell({ __RCHAT_DESKTOP__: info, __TAURI_INTERNALS__: {} })).toBe(true)
    expect(inShell({ __TAURI_INTERNALS__: {} })).toBe(false)
  })
})

describe('desktop notifier', () => {
  test('permission comes from the shell; notices and badges go to it', async () => {
    g.document = { title: '(2) RChat' }
    const { call, calls } = fakeInvoke({
      notify_permission: () => 'granted',
      notify_request: () => 'granted',
    })
    const n = desktopNotifier(call)
    expect(n.supported()).toBe(true)
    await Promise.resolve()
    await Promise.resolve()
    expect(n.permission()).toBe('granted')
    expect(await n.requestPermission()).toBe('granted')
    const handle = n.show({ title: 'Alice', body: 'hi', tag: 'c1', onClick: () => {} })
    handle?.close()
    n.setBadge(3.7)
    n.setBadge(-1)
    await Promise.resolve()
    expect(calls.map(c => [c.cmd, c.args])).toEqual([
      ['notify_permission', undefined],
      ['notify_request', undefined],
      ['notify', { title: 'Alice', body: 'hi' }],
      ['set_badge', { count: 3 }],
      ['set_badge', { count: 0 }],
    ])
    expect((g.document as { title: string }).title).toBe('RChat')
  })

  test('a denied permission stops notices and tells listeners', async () => {
    let answer = 'default'
    const { call, calls } = fakeInvoke({
      notify_permission: () => answer,
      notify_request: () => answer,
    })
    const n = desktopNotifier(call)
    const seen: string[] = []
    n.onPermissionChange(p => void seen.push(p))
    answer = 'denied'
    expect(await n.requestPermission()).toBe('denied')
    expect(n.permission()).toBe('denied')
    expect(seen).toEqual(['denied'])
    expect(n.show({ title: 't', body: 'b', tag: 'x', onClick: () => {} })).toBeNull()
    expect(calls.some(c => c.cmd === 'notify')).toBe(false)
  })

  test('a failing shell does not throw', async () => {
    g.document = { title: 'RChat' }
    const n = desktopNotifier(async () => {
      throw 'nope'
    })
    expect(await n.requestPermission()).toBe('default')
    expect(n.show({ title: 't', body: 'b', tag: 'x', onClick: () => {} }) === null).toBe(false)
    n.setBadge(1)
    await Promise.resolve()
  })
})

describe('desktop sharing', () => {
  test('copy reports the shell result', async () => {
    const ok = fakeInvoke()
    expect(await desktopSharing(ok.call, () => {}).copyText('hello')).toBe(true)
    expect(ok.calls[0]).toEqual({ cmd: 'copy_text', args: { text: 'hello' }, headers: undefined })
    const bad = desktopSharing(
      async () => {
        throw 'denied'
      },
      () => {}
    )
    expect(await bad.copyText('x')).toBe(false)
    expect(bad.canShare()).toBe(false)
    expect(await bad.share({ text: 'x' })).toBe('failed')
  })

  test('saving streams the file in pieces under the id the shell gave', async () => {
    const { call, calls } = fakeInvoke({ save_begin: () => 7 })
    const blob = new Blob([new Uint8Array(CHUNK_BYTES + 5)])
    expect(await saveTo(call, 'big.bin', blob)).toBe('saved')
    expect(calls.map(c => c.cmd)).toEqual(['save_begin', 'save_chunk', 'save_chunk', 'save_end'])
    expect(calls[0].args).toEqual({ name: 'big.bin' })
    expect((calls[1].args as Uint8Array).byteLength).toBe(CHUNK_BYTES)
    expect((calls[2].args as Uint8Array).byteLength).toBe(5)
    expect(calls[1].headers).toEqual({ 'x-save': '7' })
    expect(calls[3].args).toEqual({ id: 7, ok: true })
  })

  test('a cancelled dialog writes nothing; a failed write is aborted', async () => {
    const cancel = fakeInvoke({ save_begin: () => null })
    expect(await saveTo(cancel.call, 'a.txt', new Blob(['x']))).toBe('cancelled')
    expect(cancel.calls.map(c => c.cmd)).toEqual(['save_begin'])
    const broken = fakeInvoke({
      save_begin: () => 2,
      save_chunk: () => {
        throw 'disk full'
      },
    })
    expect(await saveTo(broken.call, 'a.txt', new Blob(['x']))).toBe('failed')
    expect(broken.calls.at(-1)).toEqual({
      cmd: 'save_end',
      args: { id: 2, ok: false },
      headers: undefined,
    })
  })

  test('a failed background save is reported, a cancelled one is not', async () => {
    const reported: string[] = []
    const broken = fakeInvoke({
      save_begin: () => 3,
      save_chunk: () => {
        throw 'disk full'
      },
    })
    expect(
      desktopSharing(broken.call, m => void reported.push(m)).saveBlob('a.bin', new Blob(['x']))
    ).toBe(true)
    const cancel = fakeInvoke({ save_begin: () => null })
    desktopSharing(cancel.call, m => void reported.push(m)).saveFile('b.txt', 'x', 'text/plain')
    const ok = fakeInvoke({ save_begin: () => 4 })
    desktopSharing(ok.call, m => void reported.push(m)).saveBlob('c.bin', new Blob(['y']))
    await new Promise(r => setTimeout(r, 20))
    expect(reported).toEqual([SAVE_FAILED])
  })

  test('opening a text file passes the limits along', async () => {
    const { call, calls } = fakeInvoke({ open_text: () => 'rc1.abc' })
    const sharing = desktopSharing(call, () => {})
    expect(await sharing.openFile('.json,.txt', 1024)).toBe('rc1.abc')
    expect(calls[0].args).toEqual({ accept: '.json,.txt', maxBytes: 1024 })
    expect(sharing.saveFile('a.json', '{}', 'application/json')).toBe(true)
  })
})

describe('shell commands', () => {
  test('settings, autostart and links map to shell commands', async () => {
    const { call, calls } = fakeInvoke({ take_deep_links: () => ['rchat://a.example/'] })
    const shell = shellOf(call)
    const settings = { close_to_tray: true, auto_update: false, channel: 'weekly' as const }
    await shell.setSettings(settings)
    await shell.setAutostart(true)
    await shell.openExternal('https://example.com/')
    expect(await shell.takeLinks()).toEqual(['rchat://a.example/'])
    expect(calls.map(c => [c.cmd, c.args])).toEqual([
      ['set_desktop_settings', { settings }],
      ['set_autostart', { on: true }],
      ['open_external', { url: 'https://example.com/' }],
      ['take_deep_links', undefined],
    ])
  })
})

describe('deep links', () => {
  const home = 'https://chat.example.com'

  test('links on this instance keep their path, query and fragment', () => {
    expect(deepLinkTarget('rchat://chat.example.com/invite/lobby/#password=pw', home)).toEqual({
      kind: 'home',
      path: '/invite/lobby/#password=pw',
    })
    expect(deepLinkTarget('rchat://Chat.Example.com/s/main/4/', home)).toEqual({
      kind: 'home',
      path: '/s/main/4/',
    })
    expect(deepLinkTarget('rchat://chat.example.com', home)).toEqual({ kind: 'home', path: '/' })
  })

  test('other hosts are other instances; loopback ones use http', () => {
    expect(deepLinkTarget('rchat://other.example/config/abcdefABCDEF/', home)).toEqual({
      kind: 'other',
      origin: 'https://other.example',
      path: '/config/abcdefABCDEF/',
      url: 'https://other.example/config/abcdefABCDEF/',
    })
    expect(deepLinkTarget('rchat://localhost:3000/dm/5/', home)).toEqual({
      kind: 'other',
      origin: 'http://localhost:3000',
      path: '/dm/5/',
      url: 'http://localhost:3000/dm/5/',
    })
  })

  test('https app links name their origin exactly', () => {
    expect(deepLinkTarget('https://chat.example.com/invite/x/#password=pw', home, true)).toEqual({
      kind: 'home',
      path: '/invite/x/#password=pw',
    })
    expect(deepLinkTarget('https://other.example:8443/s/main/2/', home, true)).toEqual({
      kind: 'other',
      origin: 'https://other.example:8443',
      path: '/s/main/2/',
      url: 'https://other.example:8443/s/main/2/',
    })
  })

  test('https app links are refused outside the mobile app', () => {
    expect(deepLinkTarget('https://chat.example.com/invite/x/', home)).toBeNull()
    expect(deepLinkTarget('https://chat.example.com/invite/x/', home, false)).toBeNull()
    expect(deepLinkTarget('rchat://chat.example.com/invite/x/', home, false)?.kind).toBe('home')
  })

  test('anything else is refused', () => {
    expect(deepLinkTarget('http://chat.example.com/invite/x/', home, true)).toBeNull()
    expect(deepLinkTarget('https://user:pw@chat.example.com/', home, true)).toBeNull()
    expect(deepLinkTarget('https://chat.example.com//evil.example/', home, true)).toBeNull()
    expect(deepLinkTarget('rchat://user:pw@chat.example.com/', home)).toBeNull()
    expect(deepLinkTarget('rchat:///invite/x/', home)).toBeNull()
    expect(deepLinkTarget('rchat://chat.example.com//evil.example/', home)).toBeNull()
    expect(deepLinkTarget('nonsense', home)).toBeNull()
  })

  const fakeEnv = (over: Partial<LinkEnv> = {}) => {
    const log: string[] = []
    const env: LinkEnv = {
      homeOrigin: home,
      appLinks: false,
      signedIn: true,
      live: true,
      push: p => void log.push(`push ${p}`),
      load: p => void log.push(`load ${p}`),
      confirmSwitch: async h => {
        log.push(`confirm ${h}`)
        return true
      },
      switchTo: async o => {
        log.push(`switch ${o}`)
        return null
      },
      openOutside: u => void log.push(`outside ${u}`),
      fail: m => void log.push(`fail ${m}`),
      ...over,
    }
    return { env, log }
  }

  test('routes by instance and sign-in state', async () => {
    const live = fakeEnv()
    await openDeepLink('rchat://chat.example.com/s/main/1/', live.env)
    expect(live.log).toEqual(['push /s/main/1/'])

    const booting = fakeEnv({ live: false })
    await openDeepLink('rchat://chat.example.com/invite/x/', booting.env)
    expect(booting.log).toEqual(['load /invite/x/'])

    const elsewhere = fakeEnv()
    await openDeepLink('rchat://other.example/invite/x/', elsewhere.env)
    expect(elsewhere.log).toEqual(['outside https://other.example/invite/x/'])

    const fresh = fakeEnv({ signedIn: false, live: false })
    await openDeepLink('rchat://other.example/invite/x/', fresh.env)
    expect(fresh.log).toEqual([
      'confirm other.example',
      'switch https://other.example',
      'load /invite/x/',
    ])

    const down = fakeEnv({ signedIn: false, live: false, switchTo: async () => "Can't reach it" })
    await openDeepLink('rchat://other.example/invite/x/', down.env)
    expect(down.log).toEqual(['confirm other.example', "fail Can't reach it"])

    const bad = fakeEnv()
    await openDeepLink('rchat://', bad.env)
    expect(bad.log).toEqual(["fail That link can't be opened here"])
  })

  test('another instance never takes over without a yes', async () => {
    const asked: string[] = []
    const declined = fakeEnv({
      signedIn: false,
      live: false,
      confirmSwitch: async h => {
        asked.push(h)
        return false
      },
    })
    await openDeepLink('rchat://evil.example:8443/login/', declined.env)
    expect(asked).toEqual(['evil.example:8443'])
    expect(declined.log).toEqual([])

    const signedIn = fakeEnv()
    await openDeepLink('rchat://evil.example/', signedIn.env)
    expect(signedIn.log).toEqual(['outside https://evil.example/'])

    const local = fakeEnv({ signedIn: false })
    await openDeepLink('rchat://chat.example.com/s/main/1/', local.env)
    expect(local.log).toEqual(['push /s/main/1/'])
  })
})

describe('share origin', () => {
  test('web pages share their own origin; app-only origins share the home instance', () => {
    expect(shareOrigin({ protocol: 'https:', origin: 'https://chat.example.com' }, false)).toBe(
      'https://chat.example.com'
    )
    expect(shareOrigin({ protocol: 'tauri:', origin: 'null' }, false)).toBe(home.origin)
    expect(shareOrigin({ protocol: 'http:', origin: 'http://tauri.localhost' }, true)).toBe(
      home.origin
    )
    expect(shareOrigin(null, false)).toBe(home.origin)
  })
})

describe('confirm gate', () => {
  test('a second ask while one is open declines and leaves the first alone', async () => {
    const shown: string[] = []
    let answer: (yes: boolean) => void = () => {}
    const gate = confirmGate((host, resolve) => {
      shown.push(host)
      answer = resolve
    })
    const first = gate('a.example')
    expect(await gate('b.example')).toBe(false)
    expect(shown).toEqual(['a.example'])
    answer(true)
    expect(await first).toBe(true)
    const third = gate('c.example')
    expect(shown).toEqual(['a.example', 'c.example'])
    answer(false)
    expect(await third).toBe(false)
  })
})

describe('mobile sharing', () => {
  test('share text puts the link on its own line', () => {
    expect(shareText({ title: 'Config', url: 'https://a.example/config/x/' })).toBe(
      'https://a.example/config/x/'
    )
    expect(shareText({ text: 'Join us', url: 'https://a.example/' })).toBe(
      'Join us\nhttps://a.example/'
    )
    expect(shareText({ title: 'Only a title' })).toBe('')
  })

  test('the share sheet reports shared, cancelled and failed', async () => {
    let answer: unknown = true
    const { call, calls } = fakeInvoke({
      share_text: () => {
        if (answer instanceof Error) throw answer
        return answer
      },
    })
    const s = mobileSharing(call, () => {})
    expect(s.canShare()).toBe(true)
    expect(await s.share({ title: 'Config', url: 'https://a.example/c/' })).toBe('shared')
    answer = false
    expect(await s.share({ url: 'https://a.example/c/' })).toBe('cancelled')
    answer = new Error('no activity')
    expect(await s.share({ url: 'https://a.example/c/' })).toBe('failed')
    expect(await s.share({ title: 'Nothing to share' })).toBe('failed')
    expect(calls.map(c => [c.cmd, c.args])).toEqual([
      ['share_text', { title: 'Config', text: 'https://a.example/c/' }],
      ['share_text', { title: null, text: 'https://a.example/c/' }],
      ['share_text', { title: null, text: 'https://a.example/c/' }],
    ])
  })

  test('copy and files use the shell commands', async () => {
    const { call, calls } = fakeInvoke({ copy_text: () => null })
    const s = mobileSharing(call, () => {})
    expect(await s.copyText('hi')).toBe(true)
    expect(calls[0]).toEqual({ cmd: 'copy_text', args: { text: 'hi' }, headers: undefined })
  })
})

describe('android back button', () => {
  const backEnv = (layers: string[], over: Partial<BackEnv> = {}) => {
    const log: string[] = []
    const env: BackEnv = {
      open: () => layers.join(','),
      escape: () => {
        log.push('escape')
        layers.pop()
      },
      settle: async () => {},
      canGoBack: true,
      back: () => void log.push('back'),
      exit: () => void log.push('exit'),
      ...over,
    }
    return { env, log }
  }

  test('closes the top layer before going back', async () => {
    const { env, log } = backEnv(['drawer', 'menu'])
    await onBack(env)
    expect(log).toEqual(['escape'])
  })

  test('goes back, then leaves at the start of the history', async () => {
    const first = backEnv([])
    await onBack(first.env)
    expect(first.log).toEqual(['back'])
    const last = backEnv([], { canGoBack: false })
    await onBack(last.env)
    expect(last.log).toEqual(['exit'])
  })

  test('a layer that ignores Escape does not trap the button', async () => {
    const { env, log } = backEnv(['stuck'], { escape: () => void log.push('escape') })
    await onBack(env)
    expect(log).toEqual(['escape', 'back'])
  })
})

describe('synthetic escape', () => {
  test('goes to the window, not the focused element', () => {
    const real = globalThis.KeyboardEvent
    globalThis.KeyboardEvent = class extends Event {
      key: string
      constructor(type: string, init: { key?: string; bubbles?: boolean; cancelable?: boolean }) {
        super(type, init)
        this.key = init.key ?? ''
      }
    } as unknown as typeof KeyboardEvent
    try {
      const win = new EventTarget()
      const seen: string[] = []
      win.addEventListener('keydown', e => void seen.push((e as KeyboardEvent).key))
      pressEscape(win)
      expect(seen).toEqual(['Escape'])
    } finally {
      globalThis.KeyboardEvent = real
    }
  })
})

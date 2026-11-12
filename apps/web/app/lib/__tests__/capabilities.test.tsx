import 'fake-indexeddb/auto'
import { afterAll, afterEach, beforeEach, describe, expect, jest, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { P2pExportOption, P2pImport, SlowNote } from '../../components/p2p/p2p_transfer'
import { ProfanitySwitch } from '../../components/settings_menu'
import { paletteCtx } from '../actions/ctx'
import { paletteRow } from '../actions/palette'
import { actionById, defineAction, runAction } from '../actions/registry'
import { settingsActions } from '../actions/settings'
import { probe, probeWasm, unavailable, UNAVAILABLE } from '../capabilities'
import {
  Cancelled,
  fastKdf,
  KDF_MAX,
  KDF_MOBILE,
  open,
  percent,
  seal,
  SLOW_AFTER,
  SLOW_KDF,
  slowKdf,
  TransferError,
  whileSlow,
  type Kdf,
  type P2pSection,
} from '../p2p/transfer'
import { runKdfJob, type KdfReply } from '../p2p/kdf_job'
import { p2pAccount, p2pTransfer, useP2p } from '../p2p/app'
import { dbFor } from '../p2p/app/account'
import { P2pStore } from '../p2p/db'
import { capabilities, setCapabilities } from '../platform'
import { filterSwitch, maskProfanity, resetMasking, setMasking, type Matcher } from '../profanity'
import { resetSessionCaches, useStore } from '../store'
import { drain, me } from './fixtures'
import { Hub, makeNode } from './p2p_net'

const g = globalThis as { WebAssembly?: unknown; localStorage: Storage }
const real = g.WebAssembly
const initial = useStore.getInitialState()

const fake: Matcher = text => text.replace(/darn/g, '****')
const counted = () => {
  const seen = { loads: 0 }
  return {
    seen,
    load: () => {
      seen.loads += 1
      return Promise.resolve(fake)
    },
  }
}

// Every test file of a run shares these: each test puts back what it found.
const wasm = Object.getOwnPropertyDescriptor(globalThis, 'WebAssembly')
let state = useStore.getState()
let first = { ...initial }
let written = new Map<string, string | null>()
let setItem = g.localStorage.setItem
let undefine = () => {}

beforeEach(() => {
  state = useStore.getState()
  first = { ...initial }
  written = new Map()
  const storage = g.localStorage
  setItem = storage.setItem
  storage.setItem = (key: string, value: string) => {
    if (!written.has(key)) written.set(key, storage.getItem(key))
    setItem.call(storage, key, value)
  }
  resetMasking()
  const filter = settingsActions.find(a => a.id === 'profanity')
  undefine = filter && !actionById('profanity') ? defineAction(filter) : () => {}
})

afterEach(() => {
  undefine()
  if (wasm) Object.defineProperty(globalThis, 'WebAssembly', wasm)
  setCapabilities(null)
  resetMasking()
  const storage = g.localStorage
  storage.setItem = setItem
  for (const [key, value] of written)
    if (value === null) storage.removeItem(key)
    else storage.setItem(key, value)
  Object.assign(initial, first)
  useStore.setState(state)
})

afterAll(resetSessionCaches)

describe('the probe', () => {
  test('a realm that compiles and runs a module has WebAssembly', () => {
    expect(probeWasm()).toBe(true)
    expect(probe()).toEqual({ wasm: true })
  })

  test('with WebAssembly removed from the realm the probe says no', () => {
    delete g.WebAssembly
    expect(probeWasm()).toBe(false)
    expect(probe()).toEqual({ wasm: false })
    g.WebAssembly = undefined
    expect(probeWasm()).toBe(false)
    expect(probeWasm({})).toBe(false)
    expect(probeWasm({ WebAssembly: {} })).toBe(false)
  })

  test('a realm that refuses to compile (a content security policy) says no', () => {
    const Wasm = real as typeof WebAssembly
    class Refused {
      constructor() {
        throw new Wasm.CompileError('Wasm code generation disallowed by embedder')
      }
    }
    expect(probeWasm({ WebAssembly: { Module: Refused, Instance: Wasm.Instance } })).toBe(false)
    class Dead {
      constructor() {
        throw new Error('no instances')
      }
    }
    expect(probeWasm({ WebAssembly: { Module: Wasm.Module, Instance: Dead } })).toBe(false)
  })

  test('the user agent is never asked', () => {
    const nav = Object.getOwnPropertyDescriptor(globalThis, 'navigator')
    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      get: () => {
        throw new Error('read the user agent')
      },
    })
    try {
      expect(probeWasm()).toBe(true)
      delete g.WebAssembly
      expect(probeWasm()).toBe(false)
    } finally {
      if (nav) Object.defineProperty(globalThis, 'navigator', nav)
      else delete (globalThis as { navigator?: unknown }).navigator
    }
  })

  test('the page probes once and keeps the answer', () => {
    expect(capabilities()).toEqual({ wasm: true })
    delete g.WebAssembly
    expect(capabilities()).toEqual({ wasm: true })
    setCapabilities(null)
    expect(capabilities()).toEqual({ wasm: false })
    g.WebAssembly = real
    expect(capabilities()).toEqual({ wasm: false })
    setCapabilities({ wasm: true })
    expect(capabilities().wasm).toBe(true)
  })

  test('every feature that is turned off says the same line first', () => {
    expect(UNAVAILABLE).toBe('Not available on this device')
    expect(unavailable('Why.')).toBe('Not available on this device. Why.')
  })
})

describe('the profanity filter without WebAssembly', () => {
  test('the matcher is never loaded and nothing is masked', async () => {
    setCapabilities({ wasm: false })
    const { seen, load } = counted()
    expect(await setMasking(true, load)).toBe(false)
    expect(seen.loads).toBe(0)
    expect(maskProfanity('darn it')).toBe('darn it')
    setCapabilities({ wasm: true })
    expect(await setMasking(true, load)).toBe(true)
    expect(seen.loads).toBe(1)
    expect(maskProfanity('darn it')).toBe('**** it')
  })

  test('the switch shows off, with the line and one reason', () => {
    expect(filterSwitch(true, true, false)).toEqual({ on: true, usable: true, note: null })
    expect(filterSwitch(true, false, false)).toEqual({ on: false, usable: true, note: null })
    const none = filterSwitch(false, true, false)
    expect([none.on, none.usable]).toEqual([false, false])
    expect(none.note).toBe(
      "Not available on this device. The filter needs WebAssembly, which this browser can't run here."
    )
    expect(filterSwitch(false, true, true)).toEqual(none)
    expect(filterSwitch(false, false, false)).toEqual(none)
    const failed = filterSwitch(true, true, true)
    expect([failed.on, failed.usable]).toEqual([false, true])
    expect(failed.note).toBe(
      'The filter could not be loaded. Check your connection, then turn it on again or reload.'
    )
  })

  test('the account keeps its choice, the page shows it off and masks nothing', async () => {
    setCapabilities({ wasm: false })
    useStore.setState({ me: me('alice'), guest: false })
    useStore.getState().setProfanityOn(true)
    await drain()
    const s = useStore.getState()
    expect([s.profanityOn, s.profanityReady]).toEqual([true, false])
    Object.assign(initial, {
      me: me('alice'),
      profanityOn: true,
      profanityFailed: s.profanityFailed,
    })
    const html = renderToStaticMarkup(<ProfanitySwitch />)
    expect(html).toContain('aria-checked="false"')
    expect(html).toContain('disabled=""')
    expect(html).toContain('Not available on this device. The filter needs WebAssembly')
    expect(html.includes('Couldn')).toBe(false)
  })

  test('with WebAssembly the switch is as before', () => {
    setCapabilities({ wasm: true })
    Object.assign(initial, { me: me('alice'), profanityOn: true, profanityFailed: false })
    const html = renderToStaticMarkup(<ProfanitySwitch />)
    expect(html).toContain('aria-checked="true"')
    expect(html.includes('disabled=""')).toBe(false)
    expect(html.includes('Not available')).toBe(false)
  })

  test('a filter that failed to load shows off and can be tried again', () => {
    setCapabilities({ wasm: true })
    Object.assign(initial, { me: me('alice'), profanityOn: true, profanityFailed: true })
    const html = renderToStaticMarkup(<ProfanitySwitch />)
    expect(html).toContain('aria-checked="false"')
    expect(html.includes('disabled=""')).toBe(false)
    expect(html).toContain('The filter could not be loaded. Check your connection')
    expect(html.includes('Not available')).toBe(false)
  })

  test('the palette row reads off, says why, and does not toggle', async () => {
    setCapabilities({ wasm: false })
    useStore.setState({
      me: me('alice'),
      guest: false,
      profanityOn: true,
      profanityFailed: false,
    })
    const action = actionById('profanity')
    if (!action) throw new Error('no profanity action')
    const row = paletteRow(action, paletteCtx(useStore.getState()))
    expect([row.title, row.subtitle]).toEqual([
      'Turn on the profanity filter',
      'Not available on this device',
    ])
    await runAction('profanity', paletteCtx(useStore.getState()))
    await drain()
    expect(useStore.getState().profanityOn).toBe(true)
    expect(useStore.getState().error).toContain('Not available on this device. The filter needs')
    setCapabilities({ wasm: true })
    const able = paletteRow(action, paletteCtx(useStore.getState()))
    expect([able.title, able.subtitle]).toEqual(['Turn off the profanity filter', undefined])
  })
})

describe('P2P passphrase protection without WebAssembly', () => {
  const LINE = 'This can take a minute or two on this device.'
  const PASS = 'päss phrase \u{1f511} long enough'
  const SALT = new Uint8Array(16).map((_, i) => i * 7 + 1)
  const SMALL: Kdf = { alg: 'argon2id', m: 1024, t: 1, p: 1 }
  const LOOSE = { min: { m: 8, t: 1, p: 1 }, max: KDF_MAX }
  const hex = (b: Uint8Array) => Array.from(b, x => x.toString(16).padStart(2, '0')).join('')
  const refusal = (p: Promise<unknown>) =>
    p.then(
      () => null,
      (e: unknown) => e
    )

  test('the fast module is not loaded where WebAssembly cannot run, and may fail to load', async () => {
    let loads = 0
    const load = () => {
      loads += 1
      return import('hash-wasm')
    }
    expect(await fastKdf(false, load)).toBe(null)
    expect(loads).toBe(0)
    expect(await fastKdf(true, () => Promise.reject(new Error('chunk gone')))).toBe(null)
    expect(typeof (await fastKdf(true, load))).toBe('function')
    expect(loads).toBe(1)
    setCapabilities({ wasm: false })
    expect(await fastKdf()).toBe(null)
  })

  test('the JavaScript key is the WebAssembly key, byte for byte', async () => {
    const fast = await fastKdf(true)
    if (!fast) throw new Error('no fast module')
    const password = new TextEncoder().encode(PASS.normalize('NFC'))
    for (const kdf of [
      SMALL,
      { alg: 'argon2id', m: 8192, t: 3, p: 1 },
      { alg: 'argon2id', m: 4096, t: 2, p: 4 },
    ] as Kdf[]) {
      const slow = await slowKdf(password, SALT, kdf)
      expect([slow.length, hex(slow)]).toEqual([32, hex(await fast(password, SALT, kdf))])
    }
  })

  test('the same holds with the parameters exports use', async () => {
    const fast = await fastKdf(true)
    if (!fast) throw new Error('no fast module')
    const password = new TextEncoder().encode(PASS.normalize('NFC'))
    const slow = await slowKdf(password, SALT, KDF_MOBILE)
    expect(hex(slow)).toBe(hex(await fast(password, SALT, KDF_MOBILE)))
  }, 120_000)

  test('a file sealed without WebAssembly opens with it, and the other way round', async () => {
    const plain = new Uint8Array([1, 2, 3, 250])
    setCapabilities({ wasm: false })
    const slow = await seal(plain, PASS, SMALL)
    expect(Array.from(await open(slow, PASS, LOOSE))).toEqual(Array.from(plain))
    setCapabilities({ wasm: true })
    expect(Array.from(await open(slow, PASS, LOOSE))).toEqual(Array.from(plain))
    const fast = await seal(plain, PASS, SMALL)
    setCapabilities({ wasm: false })
    expect(Array.from(await open(fast, PASS, LOOSE))).toEqual(Array.from(plain))
    const wrong = await refusal(open(fast, `${PASS}!`, LOOSE))
    expect((wrong as Error).message).toBe('Wrong passphrase, or the file was changed')
  })

  test('the slow work reports each percent once, up to all of it', async () => {
    setCapabilities({ wasm: false })
    const parts: number[] = []
    await seal(new Uint8Array([1]), PASS, { ...SMALL, m: 4096 }, { progress: p => parts.push(p) })
    expect(parts.length).toBeGreaterThan(50)
    expect(parts.length).toBeLessThanOrEqual(101)
    expect(parts.every((p, i) => i === 0 || p > parts[i - 1])).toBe(true)
    expect(parts[parts.length - 1]).toBe(1)
    expect([percent(0), percent(0.429), percent(1)]).toEqual(['0%', '42%', '100%'])
  })

  test('the slow work stops when the user cancels, on export and on unlock', async () => {
    setCapabilities({ wasm: false })
    const heavy: Kdf = { ...SMALL, m: 16384, t: 3 }
    const stopAt = (ctl: AbortController, seen: number[]) => (p: number) => {
      seen.push(p)
      if (p >= 0.1) ctl.abort()
    }
    const a = new AbortController()
    const sealed: number[] = []
    const failed = await refusal(
      seal(new Uint8Array([1]), PASS, heavy, { progress: stopAt(a, sealed), signal: a.signal })
    )
    expect(failed instanceof Cancelled).toBe(true)
    expect(failed instanceof TransferError).toBe(true)
    expect(Math.max(...sealed)).toBeLessThan(0.2)
    const section = await seal(new Uint8Array([1]), PASS, SMALL)
    const b = new AbortController()
    const opened: number[] = []
    const unlock = open({ ...section, kdf: heavy }, PASS, LOOSE, {
      progress: stopAt(b, opened),
      signal: b.signal,
    })
    expect((await refusal(unlock)) instanceof Cancelled).toBe(true)
    expect(Math.max(...opened)).toBeLessThan(0.2)
    const c = new AbortController()
    c.abort()
    const never = seal(new Uint8Array([1]), PASS, SMALL, { signal: c.signal })
    expect((await refusal(never)) instanceof Cancelled).toBe(true)
    setCapabilities({ wasm: true })
    expect(
      (await refusal(seal(new Uint8Array([1]), PASS, SMALL, { signal: c.signal }))) instanceof
        Cancelled
    ).toBe(true)
  })

  test('the page gets turns while the key is made', async () => {
    setCapabilities({ wasm: false })
    let turns = 0
    const timer = setInterval(() => {
      turns += 1
    }, 1)
    await seal(new Uint8Array([1]), PASS, { ...SMALL, m: 32768, t: 3 })
    clearInterval(timer)
    expect(turns).toBeGreaterThan(3)
  })

  const spawn = () =>
    new Worker(new URL('../p2p/p2p.worker.ts', import.meta.url), { type: 'module' })
  const password = () => new TextEncoder().encode(PASS.normalize('NFC'))

  test('the worker job gives the same key and each percent once', async () => {
    const fast = await fastKdf(true)
    if (!fast) throw new Error('no fast module')
    const kdf: Kdf = { ...SMALL, m: 4096, t: 2 }
    const replies: KdfReply[] = []
    const mine = password()
    runKdfJob(
      { id: 7, kdf: { password: mine, salt: SALT, m: kdf.m, t: kdf.t, p: kdf.p, maxmem: 2 ** 28 } },
      m => replies.push(m)
    )
    const last = replies[replies.length - 1]
    if (!('key' in last)) throw new Error('no key')
    expect(hex(last.key)).toBe(hex(await fast(password(), SALT, kdf)))
    const parts = replies.slice(0, -1).map(m => ('part' in m ? m.part : -1))
    expect(parts.length).toBeGreaterThan(50)
    expect(parts.every((p, i) => p >= 0 && (i === 0 || p > parts[i - 1]))).toBe(true)
    expect(parts[parts.length - 1]).toBe(1)
    expect(replies.every(m => m.id === 7)).toBe(true)
    expect(mine.every(b => b === 0)).toBe(true)
    const refused: KdfReply[] = []
    runKdfJob(
      { id: 8, kdf: { password: password(), salt: SALT, m: 4096, t: 1, p: 1, maxmem: 1024 } },
      m => refused.push(m)
    )
    expect(refused.length).toBe(1)
    expect('err' in refused[0]).toBe(true)
  })

  test('in a worker: the same key, progress, and a stop that ends the work at once', async () => {
    const fast = await fastKdf(true)
    if (!fast) throw new Error('no fast module')
    const kdf: Kdf = { ...SMALL, m: 8192, t: 3 }
    const parts: number[] = []
    const key = await slowKdf(password(), SALT, kdf, { progress: p => parts.push(p) }, spawn)
    expect(hex(key)).toBe(hex(await fast(password(), SALT, kdf)))
    expect(parts[parts.length - 1]).toBe(1)
    expect(parts.length).toBeGreaterThan(50)
    const ctl = new AbortController()
    const seen: number[] = []
    const heavy: Kdf = { ...SMALL, m: 65536, t: 10 }
    const started = Date.now()
    const stopped = await refusal(
      slowKdf(
        password(),
        SALT,
        heavy,
        {
          progress: p => {
            seen.push(p)
            ctl.abort()
          },
          signal: ctl.signal,
        },
        spawn
      )
    )
    expect(stopped instanceof Cancelled).toBe(true)
    expect(seen.length).toBe(1)
    expect(Date.now() - started).toBeLessThan(20_000)
    const before = new AbortController()
    before.abort()
    let spawned = 0
    const counted = () => {
      spawned += 1
      return spawn()
    }
    const never = slowKdf(password(), SALT, SMALL, { signal: before.signal }, counted)
    expect((await refusal(never)) instanceof Cancelled).toBe(true)
    expect(spawned).toBe(0)
    const heavyFail = await refusal(slowKdf(password(), SALT, { ...SMALL, m: 2 ** 22 }, {}, spawn))
    expect(heavyFail instanceof Error && !(heavyFail instanceof TransferError)).toBe(true)
  }, 60_000)

  test('where the worker cannot start, the page makes the key itself', async () => {
    const fast = await fastKdf(true)
    if (!fast) throw new Error('no fast module')
    const want = hex(await fast(password(), SALT, SMALL))
    const refusedToStart = () => {
      throw new Error('no workers here')
    }
    expect(hex(await slowKdf(password(), SALT, SMALL, {}, refusedToStart))).toBe(want)
    const broken = () => {
      const w = {
        onmessage: null as unknown,
        onerror: null as (() => void) | null,
        terminated: 0,
        postMessage: () => queueMicrotask(() => w.onerror?.()),
        terminate: () => {
          w.terminated += 1
        },
      }
      made.push(w)
      return w as unknown as Worker
    }
    const made: { terminated: number }[] = []
    const parts: number[] = []
    const key = await slowKdf(password(), SALT, SMALL, { progress: p => parts.push(p) }, broken)
    expect(hex(key)).toBe(want)
    expect(made.map(w => w.terminated)).toEqual([1])
    expect(parts[parts.length - 1]).toBe(1)
    expect(hex(await slowKdf(password(), SALT, SMALL, {}, null))).toBe(want)
  })

  test('the export option and the import say nothing up front about a slow key', () => {
    const pass = { pass: '', again: '', files: false }
    const section = { v: 1 } as unknown as P2pSection
    Object.assign(initial, { me: me('alice') })
    for (const wasm of [false, true]) {
      setCapabilities({ wasm })
      const option = renderToStaticMarkup(
        <P2pExportOption on onToggle={() => {}} value={pass} onChange={() => {}} />
      )
      expect(option).toContain('checked=""')
      expect(option.includes('disabled=""')).toBe(false)
      expect(option).toContain('placeholder="Passphrase (at least 10 characters)"')
      const html = renderToStaticMarkup(<P2pImport section={section} />)
      expect(html).toContain('placeholder="Passphrase"')
      for (const shown of [option, html])
        expect([wasm, shown.includes(LINE), shown.includes('Not available')]).toEqual([
          wasm,
          false,
          false,
        ])
    }
  })

  test('the slow line shows once the work has run 2 seconds, until it ends', async () => {
    expect(SLOW_KDF).toBe(LINE)
    expect(renderToStaticMarkup(<SlowNote />)).toContain(`role="status"`)
    expect(renderToStaticMarkup(<SlowNote />)).toContain(LINE)
    jest.useFakeTimers()
    try {
      const run = <T,>(work: Promise<T>) => {
        const seen: boolean[] = []
        const out = whileSlow(work, on => seen.push(on)).then(
          value => ({ value }),
          (error: unknown) => ({ error })
        )
        return { seen, out }
      }
      const later = () => {
        const hooks = {} as { finish: (key: string) => void; fail: (e: unknown) => void }
        const work = new Promise<string>((finish, fail) => Object.assign(hooks, { finish, fail }))
        return { work, ...hooks }
      }
      // Quick work: the line never shows.
      const first = later()
      const quick = run(first.work)
      jest.advanceTimersByTime(1500)
      first.finish('key')
      expect(await quick.out).toEqual({ value: 'key' })
      jest.advanceTimersByTime(5000)
      expect(quick.seen).toEqual([false])
      // Slow work: not before 2 seconds, then until it ends.
      const second = later()
      const slow = run(second.work)
      jest.advanceTimersByTime(SLOW_AFTER - 1)
      await drain()
      expect(slow.seen).toEqual([])
      jest.advanceTimersByTime(1)
      expect(slow.seen).toEqual([true])
      jest.advanceTimersByTime(60_000)
      expect(slow.seen).toEqual([true])
      second.finish('key')
      expect(await slow.out).toEqual({ value: 'key' })
      expect(slow.seen).toEqual([true, false])
      // Failed or cancelled work clears it too, and the error passes through.
      for (const error of [new Cancelled(), new Error('out of memory')]) {
        const third = later()
        const stopped = run(third.work)
        jest.advanceTimersByTime(SLOW_AFTER)
        expect(stopped.seen).toEqual([true])
        third.fail(error)
        expect(await stopped.out).toEqual({ error })
        expect(stopped.seen).toEqual([true, false])
      }
    } finally {
      jest.useRealTimers()
    }
  })

  test('a Cancel once the key is made drops the export and leaves sending on', async () => {
    const realWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
    delete (globalThis as { window?: unknown }).window
    setCapabilities({ wasm: false })
    const username = `cancel-${Math.random().toString(36).slice(2)}`
    const made = await makeNode(new Hub(), 'carol', { db: dbFor(username) })
    made.node.stop()
    made.store.close()
    try {
      await p2pAccount(username)
      const stored = async () => {
        const s = await P2pStore.open(dbFor(username))
        const self = await s.self()
        s.close()
        return [self?.moving ?? null, self?.exported ?? null]
      }
      // Cancel at 100%: the work that is left is quick, and nothing is written.
      const ctl = new AbortController()
      const parts: number[] = []
      const watch = {
        progress: (p: number) => {
          parts.push(p)
          if (p === 1) ctl.abort()
        },
        signal: ctl.signal,
      }
      const dropped = await refusal(p2pTransfer.exportSection(PASS, SMALL, false, watch))
      expect(parts[parts.length - 1]).toBe(1)
      expect(dropped instanceof Cancelled).toBe(true)
      expect(useP2p.getState().movingAt).toBeNull()
      expect(await stored()).toEqual([null, null])
      // Without a Cancel, sending pauses as before.
      const done = await p2pTransfer.exportSection(PASS, SMALL, false, {})
      expect(done.section.kdf).toEqual(SMALL)
      expect(useP2p.getState().movingAt).not.toBeNull()
      expect((await stored()).every(x => x !== null)).toBe(true)
    } finally {
      await p2pAccount(null)
      if (realWindow) Object.defineProperty(globalThis, 'window', realWindow)
    }
  }, 60_000)
})

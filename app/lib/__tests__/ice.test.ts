import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  IceCache,
  RETRY_MS,
  cleanServers,
  helpersValue,
  iceConfig,
  iceOffer,
  iceValue,
  parseHelpers,
  parseIce,
  relayOnly,
  type IceSource,
  type Timers,
} from '../ice'
import type { IceServers, InstanceIce } from '../types'

const sources = () => {
  const root = fileURLToPath(new URL('../..', import.meta.url))
  const files: string[] = []
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) {
        if (entry.name !== '__tests__') walk(path)
      } else if (/\.(ts|tsx)$/.test(entry.name)) files.push(path)
    }
  }
  walk(root)
  return files.map(f => ({ f, src: readFileSync(f, 'utf8') }))
}

describe('ICE config', () => {
  test('nothing is configured until the instance advertises servers', () => {
    expect(iceConfig()).toEqual({ iceServers: [] })
    expect(iceConfig() === iceConfig()).toBe(false)
  })

  test('no ICE server URL is written anywhere but ice.ts', () => {
    const hard = sources().filter(
      ({ f, src }) => !f.endsWith('/ice.ts') && /['"`](?:stun|stuns|turn|turns):/.test(src)
    )
    expect(hard.map(h => h.f)).toEqual([])
  })

  test('every peer connection uses the instance ICE config', () => {
    const files = sources()
    expect(files.length > 20).toBe(true)
    const rel = (f: string) => f.slice(f.lastIndexOf('/') + 1)
    const outside = files.filter(
      ({ f, src }) => /\bRTCPeerConnection\b/.test(src) && !/\/(rtc|ice)\.ts$/.test(f)
    )
    expect(outside.map(o => rel(o.f))).toEqual([])
    const peerjs = files.filter(({ src }) => /from\s+['"]peerjs['"]/.test(src))
    expect(peerjs.map(o => rel(o.f))).toEqual(['p2p.ts'])
    const rtc = files.find(({ f }) => f.endsWith('/rtc.ts'))
    const p2p = files.find(({ f }) => f.endsWith('/p2p.ts'))
    expect(
      /new\s+(?:window\.)?\w*RTCPeerConnection\s*\(\s*iceConfig\(\)\s*\)/.test(rtc?.src ?? '')
    ).toBe(true)
    const peers = [...(p2p?.src ?? '').matchAll(/new\s+Peer\s*\(([^;]*?)\)\s*(?:\n|;|$)/g)]
    expect(peers.length > 0).toBe(true)
    expect(peers.filter(m => !/\bconfig\s*:\s*iceConfig\(\s*\)/.test(m[1]))).toEqual([])
  })
})

const timers = () => {
  const pending: { fn: () => void; ms: number; id: number }[] = []
  let next = 1
  const t: Timers = {
    set: (fn, ms) => {
      const id = next++
      pending.push({ fn, ms, id })
      return id
    },
    clear: id => {
      const at = pending.findIndex(p => p.id === id)
      if (at >= 0) pending.splice(at, 1)
    },
  }
  return { t, pending }
}

const setup = (info: InstanceIce | null, responses: (IceServers | Error)[], now = 1_000_000) => {
  const calls = { fetch: 0 }
  const src: IceSource = {
    info: () => info,
    fetch: async () => {
      calls.fetch++
      const r = responses.shift()
      if (!r || r instanceof Error) throw r ?? new Error('no response')
      return r
    },
    now: () => now,
  }
  const clock = timers()
  return { cache: new IceCache(src, clock.t), calls, pending: clock.pending }
}

const turnEntry = {
  urls: ['turn:relay.example.com:3478?transport=udp'],
  username: '1003600:abcd',
  credential: 'pw',
}

describe('IceCache', () => {
  test('with everything off there are no servers and nothing is fetched', async () => {
    const { cache, calls, pending } = setup({ stun: [], turn: false, relay: false }, [])
    expect(await cache.setSignedIn(true)).toEqual({ iceServers: [] })
    expect(calls.fetch).toBe(0)
    expect(pending).toEqual([])
    const old = setup(null, [])
    expect(await old.cache.setSignedIn(true)).toEqual({ iceServers: [] })
  })

  test('public STUN comes from discovery without a request', async () => {
    const stun = ['stun:stun.example.org:3478', 'stun:chat.example.com:3478']
    const { cache, calls } = setup({ stun, turn: false, relay: true }, [])
    expect((await cache.setSignedIn(false)).iceServers).toEqual([{ urls: stun }])
    expect(calls.fetch).toBe(0)
  })

  test('signed-in users fetch TURN credentials; guests stay on STUN', async () => {
    const info = { stun: ['stun:chat.example.com:3478'], turn: true, relay: true }
    const servers = [{ urls: ['stun:chat.example.com:3478'] }, turnEntry]
    const guest = setup(info, [])
    expect((await guest.cache.setSignedIn(false)).iceServers).toEqual([
      { urls: ['stun:chat.example.com:3478'] },
    ])
    expect(guest.calls.fetch).toBe(0)
    const user = setup(info, [{ ice_servers: servers, expires_at: 1_000 + 3600 }])
    expect((await user.cache.setSignedIn(true)).iceServers).toEqual(servers)
    expect(user.calls.fetch).toBe(1)
  })

  test('credentials refresh at 80% of their lifetime and retry after errors', async () => {
    const info = { stun: [], turn: true, relay: true }
    const first = { ice_servers: [turnEntry], expires_at: 1_000 + 3600 }
    const second = {
      ice_servers: [{ ...turnEntry, username: '1007200:abcd' }],
      expires_at: 1_000 + 7200,
    }
    const { cache, calls, pending } = setup(info, [first, new Error('offline'), second])
    let changes = 0
    cache.onChange(() => changes++)
    await cache.setSignedIn(true)
    expect(pending.map(p => p.ms)).toEqual([3600 * 1000 * 0.8])
    const tick = async () => {
      const job = pending.shift()
      job?.fn()
      await new Promise(r => setTimeout(r, 0))
    }
    await tick()
    expect(calls.fetch).toBe(2)
    expect(pending.map(p => p.ms)).toEqual([RETRY_MS])
    expect(cache.servers()[0]?.username).toBe('1003600:abcd')
    await tick()
    expect(calls.fetch).toBe(3)
    expect(cache.servers()[0]?.username).toBe('1007200:abcd')
    expect(pending.length).toBe(1)
    expect(changes).toBe(3)
    cache.stop()
    expect(pending).toEqual([])
  })

  test('turning connection helpers off empties the config', async () => {
    const { cache } = setup({ stun: ['stun:s.example.org:3478'], turn: false, relay: false }, [])
    await cache.refresh()
    cache.setHelpers(false)
    expect(cache.config()).toEqual({ iceServers: [] })
    cache.setHelpers(true)
    expect(cache.config().iceServers?.length).toBe(1)
    cache.policy = 'relay'
    expect(cache.config().iceTransportPolicy).toBe('relay')
  })

  test('relay only forces relayed candidates while the instance has a relay and helpers are on', async () => {
    const info = { stun: ['stun:r.example.org:3478'], turn: true, relay: true }
    const { cache } = setup(info, [{ ice_servers: [turnEntry], expires_at: 1003600 }])
    expect(cache.config().iceTransportPolicy).toBeUndefined()
    let changes = 0
    cache.onChange(() => (changes += 1))
    cache.setRelay(true)
    expect([changes, cache.relayActive()]).toEqual([1, true])
    expect(cache.config()).toEqual({ iceServers: [], iceTransportPolicy: 'relay' })
    await cache.setSignedIn(true)
    expect(cache.config()).toEqual({ iceServers: [turnEntry], iceTransportPolicy: 'relay' })
    cache.setHelpers(false)
    expect(cache.config()).toEqual({ iceServers: [] })
    cache.setHelpers(true)
    cache.setRelay(false)
    expect(cache.config().iceTransportPolicy).toBeUndefined()
    expect(relayOnly({ stun: [], turn: false, relay: false }, true, true)).toBe(false)
    expect(relayOnly(info, false, true)).toBe(false)
    expect(relayOnly(null, true, true)).toBe(false)
    expect(relayOnly(info, true, true)).toBe(true)
    const none = setup({ stun: ['stun:s.example.org:3478'], turn: false, relay: false }, [])
    none.cache.setRelay(true)
    expect(none.cache.config().iceTransportPolicy).toBeUndefined()
  })

  test('a slow answer from before a sign-out is ignored', async () => {
    let release: (v: IceServers) => void = () => {}
    const src: IceSource = {
      info: () => ({ stun: [], turn: true, relay: true }),
      fetch: () => new Promise(r => (release = r)),
      now: () => 0,
    }
    const cache = new IceCache(src, timers().t)
    const slow = cache.setSignedIn(true)
    await cache.setSignedIn(false)
    release({ ice_servers: [turnEntry], expires_at: 3600 })
    await slow
    expect(cache.servers()).toEqual([])
  })

  test('server entries are checked before use', () => {
    expect(
      cleanServers([
        { urls: 'stun:a.example:3478' },
        { urls: ['https://evil.example', 'turn:b.example:3478'], username: 'u', credential: 'c' },
        { urls: ['javascript:alert(1)'] },
        null,
        'stun:x',
        { urls: [42] },
      ])
    ).toEqual([
      { urls: ['stun:a.example:3478'] },
      { urls: ['turn:b.example:3478'], username: 'u', credential: 'c' },
    ])
    expect(cleanServers(null)).toEqual([])
  })

  test('the helpers setting is versioned and defaults to on', () => {
    expect(parseHelpers(null)).toBe(true)
    expect(parseHelpers('nope')).toBe(true)
    expect(parseHelpers('{"v":2,"on":false}')).toBe(true)
    expect(parseHelpers(helpersValue(false))).toBe(false)
    expect(parseHelpers(helpersValue(true))).toBe(true)
    expect(parseIce(null)).toEqual({ on: true, relay: false })
    expect(parseIce('{"v":1,"on":false}')).toEqual({ on: false, relay: false })
    expect(parseIce('{"v":1,"on":true,"relay":"yes"}')).toEqual({ on: true, relay: false })
    expect(parseIce(iceValue({ on: true, relay: true }))).toEqual({ on: true, relay: true })
    expect(parseIce(iceValue({ on: false, relay: true }))).toEqual({ on: false, relay: true })
  })

  test('the offer line names what the instance runs', () => {
    expect(iceOffer({ stun: [], turn: false, relay: false })).toEqual([])
    expect(iceOffer({ stun: ['stun:a', 'stun:b', 'stun:c'], turn: false, relay: false })).toEqual([
      'Public STUN (3 servers)',
    ])
    expect(iceOffer({ stun: ['stun:a', 'stun:r'], turn: true, relay: true })).toEqual([
      'Public STUN (1 server)',
      'Instance relay',
    ])
    expect(iceOffer({ stun: [], turn: true, relay: false })).toEqual(['Relay servers'])
  })
})

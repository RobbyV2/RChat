import { expect, test } from 'bun:test'
import { blobs, setBlobs } from '../platform'
import { client } from '../client/client'
import { testAccount } from './test_account'
import type { Decision } from '../relays'
import type { IceServers, VoiceMsg } from '../types'
import { Secret } from '../secret'

const turn = (credential: string): IceServers => ({
  ice_servers: [{ urls: ['turn:relay.example:3478'], username: 'user', credential }],
  expires_at: Math.floor(Date.now() / 1000) + 3600,
})

test('ICE credentials, relay preferences and pending consent follow their owner through release', async () => {
  const a = testAccount('sam', 'https://a.test')
  const b = testAccount('sam', 'https://b.test')
  try {
    for (const account of [a, b]) {
      Object.defineProperty(account.conn, 'info', {
        get: () => ({ ice: { stun: [], turn: true, relay: false } }),
      })
    }
    const late = Promise.withResolvers<IceServers>()
    a.api.p2pIce = () => late.promise
    b.api.p2pIce = async () => turn('for-b')
    const refreshing = a.ice.setSignedIn(true)
    await b.ice.setSignedIn(true)
    const asked = Promise.withResolvers<void>()
    const answer = Promise.withResolvers<Decision>()
    a.relays.prompt = () => {
      asked.resolve()
      return answer.promise
    }
    b.relays.prompt = async () => 'always'
    const pending = a.relays.consent(['shared.example'])
    await asked.promise
    expect(await b.relays.consent(['other.example'])).toBeNull()
    expect(a.relays.prefs.allowed).toEqual([])
    a.store.dispose()
    answer.resolve('always')
    late.resolve(turn('for-a'))
    await refreshing
    expect(await pending).toBe('shared.example')
    expect(a.ice.servers()).toEqual([])
    expect(a.relays.prefs.allowed).toEqual([])
    expect(b.relays.prefs.allowed).toEqual(['other.example'])
    expect(b.relays.autoConfig().iceServers).toEqual(turn('for-b').ice_servers)
  } finally {
    if (client.live().includes(a)) a.store.dispose()
    b.store.dispose()
  }
})

test('each RTC manager signals its own socket and releases only its own microphone and peers', async () => {
  const a = testAccount('a')
  const b = testAccount('b')
  const media = Object.getOwnPropertyDescriptor(navigator, 'mediaDevices')
  const pc = Object.getOwnPropertyDescriptor(globalThis, 'RTCPeerConnection')
  const stopped: number[] = []
  const sent: VoiceMsg[][] = [[], []]
  let capture = 0
  try {
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: {
        getUserMedia: async () => {
          const n = ++capture
          return { getAudioTracks: () => [], getTracks: () => [{ stop: () => stopped.push(n) }] }
        },
      },
    })
    Object.defineProperty(globalThis, 'RTCPeerConnection', {
      configurable: true,
      value: class {
        close() {}
      },
    })
    for (const [i, account] of [a, b].entries()) {
      account.conn.ws.sendVoice = msg => {
        sent[i].push(msg)
        return true
      }
      await account.rtc.join('sam', { dmId: 7 }, true)
      account.rtc.sync(['z'])
    }
    for (const messages of sent) {
      expect(messages).toHaveLength(1)
      expect(messages[0]).toMatchObject({
        type: 'rtc_signal',
        to: 'z',
        dm_id: 7,
        payload: { muted: true },
      })
    }
    a.rtc.dispose()
    expect(stopped).toEqual([1])
    expect(a.rtc.peer('z')).toBeUndefined()
    expect(b.rtc.peer('z')).not.toBeUndefined()
    b.rtc.setMuted(false)
    expect(sent.map(s => s.length)).toEqual([1, 2])
  } finally {
    a.store.dispose()
    b.store.dispose()
    if (media) Object.defineProperty(navigator, 'mediaDevices', media)
    else Reflect.deleteProperty(navigator, 'mediaDevices')
    if (pc) Object.defineProperty(globalThis, 'RTCPeerConnection', pc)
    else Reflect.deleteProperty(globalThis, 'RTCPeerConnection')
  }
})

test('identical media paths on one origin use separate credentials, blobs and abort signals', async () => {
  const a = testAccount('alice', 'http://localhost')
  const b = testAccount('bob', 'http://localhost')
  const fetcher = globalThis.fetch
  const requests: {
    auth: string | null
    grant: string | null
    cookie?: RequestCredentials
    signal?: AbortSignal | null
  }[] = []
  const image = () => new Response(new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0]))
  const late = Promise.withResolvers<Response>()
  try {
    globalThis.fetch = (async (url, init) => {
      const headers = new Headers(init?.headers)
      requests.push({
        auth: headers.get('Authorization'),
        grant: headers.get('X-Guest-Grant'),
        cookie: init?.credentials,
        signal: init?.signal,
      })
      return String(url).endsWith('/pending') ? late.promise : image()
    }) as typeof fetch
    a.api.setGrants({ room: Secret.of('a-grant') })
    b.api.setToken(Secret.of('b-token'))
    const path = a.api.mediaUrl('same')
    expect(b.api.mediaUrl('same')).toBe(path)
    expect(a.media.mediaModeFor('room')).toBe('blob')
    expect(b.media.mediaModeFor('room')).toBe('blob')
    const first = a.media.acquire(path, 'room')
    const second = b.media.acquire(path, 'room')
    const [mine, other] = await Promise.all([first.url, second.url])
    if (!mine || !other) throw new Error('Images should have object URLs')
    expect(mine).not.toEqual(other)
    expect(requests[0]).toMatchObject({ auth: null, grant: 'a-grant', cookie: 'omit' })
    expect(requests[1]).toMatchObject({ auth: 'Bearer b-token', grant: null, cookie: 'omit' })
    const waiting = a.media.acquire(a.api.mediaUrl('pending'), 'room')
    a.media.clear()
    expect(
      await fetcher(mine).then(
        () => true,
        () => false
      )
    ).toBe(false)
    expect((await fetcher(other)).ok).toBe(true)
    expect(requests[2]?.signal?.aborted).toBe(true)
    expect(requests[1]?.signal?.aborted).toBe(false)
    late.resolve(image())
    expect(await waiting.url).toBeNull()
    const again = b.media.acquire(path, 'room')
    expect(await again.url).toBe(other)
    expect(requests).toHaveLength(3)
    for (const ref of [first, second, again, waiting]) ref.release()
  } finally {
    globalThis.fetch = fetcher
    a.store.dispose()
    b.store.dispose()
  }
})

test('disposing a file manager cancels staging and preserves both accounts’ stored files', async () => {
  const a = testAccount('sam', 'https://a.test')
  const b = testAccount('sam', 'https://b.test')
  const original = blobs()
  const stored = new Map<string, Blob>()
  const pending = Promise.withResolvers<void>()
  const started = Promise.withResolvers<void>()
  try {
    setBlobs({
      ...original,
      put: async (key, blob, live) => {
        if (key.endsWith(':pending')) {
          started.resolve()
          await pending.promise
        }
        if (!live || live()) stored.set(key, blob)
      },
      get: async key => stored.get(key) ?? null,
      remove: async key => {
        stored.delete(key)
      },
    })
    for (const session of [a, b]) {
      session.files.setAccount('sam')
      await session.files.stage('same', new File([session.id], 'hello.txt'), null)
    }
    expect(await (await a.files.blob('same'))?.text()).toBe(a.id)
    expect(await (await b.files.blob('same'))?.text()).toBe(b.id)
    const writing = a.files.stage('pending', new File(['late'], 'pending.txt'), null)
    await started.promise
    a.store.dispose()
    pending.resolve()
    expect(
      await writing.then(
        () => '',
        (e: Error) => e.message
      )
    ).toBe('Download canceled')
    expect(stored.size).toBe(2)
    expect(a.files.file('pending')).toBeNull()
    expect(await (await b.files.blob('same'))?.text()).toBe(b.id)
  } finally {
    if (client.live().includes(a)) a.store.dispose()
    b.store.dispose()
    setBlobs(original)
  }
})

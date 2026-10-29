import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { configSourceOf, useStore, resetSessionCaches } from '../store'
import { home } from '../instances'
import { emptyLayout, layoutKey } from '../nav_layout'
import { EMPTY_NOTIFY, notifyKey, setLevel, setMute } from '../notify'
import { EMPTY_PREFS, emojiKey, noteUse } from '../emoji'
import {
  PREFIX,
  SECTIONS,
  buildConfig,
  decodeConfig,
  encodeConfig,
  hasStashedConfig,
  type ConfigDoc,
  type SectionKey,
} from '../config_transfer'
import type { DmSummary, ServerSummary } from '../types'
import { me, user } from './fixtures'

afterAll(resetSessionCaches)

const st = () => useStore.getState()
const ALL = new Set<SectionKey>(SECTIONS.map(s => s.key))

const local = new Map<string, string>()
const session = new Map<string, string>()
const storageOf = (m: Map<string, string>) => ({
  getItem: (k: string) => m.get(k) ?? null,
  setItem: (k: string, v: string) => void m.set(k, String(v)),
  removeItem: (k: string) => void m.delete(k),
  clear: () => m.clear(),
  key: (i: number) => [...m.keys()][i] ?? null,
  get length() {
    return m.size
  },
})

const srv = (name: string): ServerSummary => ({
  name,
  display_name: name,
  creator: null,
  is_admin: false,
})
const dm = (id: number, other: string, is_self = false): DmSummary => ({
  id,
  other: user(other),
  is_self,
})

const realFetch = globalThis.fetch
const realWindow = (globalThis as { window?: unknown }).window
const realDocument = (globalThis as { document?: unknown }).document
let requests: string[] = []

const inflate = async (text: string) => {
  const bin = atob(text.slice(PREFIX.length).replace(/-/g, '+').replace(/_/g, '/'))
  const stream = new Blob([Uint8Array.from(bin, c => c.charCodeAt(0))])
    .stream()
    .pipeThrough(new DecompressionStream('deflate-raw'))
  return new Response(stream).text()
}

beforeEach(() => {
  local.clear()
  session.clear()
  requests = []
  Object.assign(globalThis, { localStorage: storageOf(local) })
  ;(globalThis as { window?: unknown }).window = {
    location: { pathname: '/', href: 'http://x/', origin: 'http://x', protocol: 'http:' },
    history: { state: null, pushState: () => {}, replaceState: () => {} },
    sessionStorage: storageOf(session),
  }
  ;(globalThis as { document?: unknown }).document = {
    documentElement: { dataset: {} },
    querySelector: () => null,
    body: { classList: { toggle: () => {} } },
  }
  globalThis.fetch = (async (input: string, init?: RequestInit) => {
    requests.push(`${init?.method ?? 'GET'} ${input}`)
    if ((init?.method ?? 'GET') === 'PATCH')
      return new Response(JSON.stringify({ ...user('bob'), appear_offline: true }), {
        status: 200,
      })
    return new Response('[]', { status: 200 })
  }) as unknown as typeof fetch
})

afterEach(() => {
  globalThis.fetch = realFetch
  ;(globalThis as { window?: unknown }).window = realWindow
  ;(globalThis as { document?: unknown }).document = realDocument
  useStore.setState({ me: null, token: null, guest: false, drafts: {} })
})

const SECRETS = [
  'TOKEN-0f9e8d7c6b5a',
  'GRANT-1a2b3c4d5e6f',
  'GUESTNAME-secret',
  'INVITE-PASSWORD-77',
  'PEER-ID-abcdef',
  'P2P-FILE-NAME-xyz',
  'DRAFT-TEXT-hush',
  'SERVER-PW-correct-horse',
  'FORWARD-CLIP-body',
  'ACCOUNT-PASSWORD-hunter2',
]

describe('export never carries secrets', () => {
  test('a populated store and storage give a document with only config', async () => {
    const t = home.scoped('rchat_token')
    local.set(t, SECRETS[0])
    local.set(home.scoped('rchat_guest_grants'), JSON.stringify({ club: SECRETS[1] }))
    local.set(home.scoped('rchat_guest_names'), JSON.stringify({ club: SECRETS[2] }))
    session.set(
      'rchat_invite',
      JSON.stringify({ server: 'club', password: SECRETS[3], at: Date.now() })
    )
    local.set('rchat_peer_id', SECRETS[4])
    local.set('rchat_p2p_files', JSON.stringify({ f1: { name: SECRETS[5] } }))
    local.set(
      home.scoped('rchat_server_passwords:alice'),
      JSON.stringify({ v: 1, club: { 9: SECRETS[7] } })
    )
    local.set(home.scoped('rchat_forward:alice'), JSON.stringify({ v: 1, content: SECRETS[8] }))
    local.set('rchat_theme', 'light')
    local.set('rchat_streamer', '1')
    let notify = setLevel(EMPTY_NOTIFY, { kind: 'server', name: 'club' }, 'all')
    notify = setMute(notify, { kind: 'dm', id: 5 }, 'forever')
    useStore.setState({
      me: me('alice', { appear_offline: true, servers: [srv('rchat'), srv('club')] }),
      token: SECRETS[0],
      guest: false,
      theme: 'light',
      streamer: true,
      drafts: { c1: SECRETS[6], d5: SECRETS[6] },
      layout: {
        ...emptyLayout,
        servers: ['club', 'rchat'],
        dmOrder: [5],
        dmPinned: [5],
        dmSeen: 12,
      },
      notifyPrefs: notify,
      emoji: noteUse(EMPTY_PREFS, '👍', '👍', Date.now()),
    })
    const doc = buildConfig(configSourceOf(st()), ALL)
    const text = await encodeConfig(doc)
    const json = await inflate(text)
    for (const secret of [...SECRETS, ...local.values(), ...session.values()].filter(v =>
      SECRETS.some(s => v.includes(s))
    ))
      expect(json.includes(secret)).toBe(false)
    for (const word of ['token', 'grant', 'password', 'peer', 'draft', 'forward', 'dmSeen'])
      expect(json.toLowerCase().includes(word.toLowerCase())).toBe(false)
    const decoded = await decodeConfig(text)
    expect(decoded.ok && Object.keys(decoded.doc).sort()).toEqual(
      [
        'appearOffline',
        'calls',
        'emoji',
        'layout',
        'notify',
        'streamer',
        'theme',
        'typing',
        'v',
      ].sort()
    )
  })

  test('a guest exports device and layout sections only', () => {
    useStore.setState({ me: null, guest: true, token: null, guestServers: ['rchat'] })
    const doc = buildConfig(configSourceOf(st()), ALL)
    expect(Object.keys(doc).sort()).toEqual([
      'layout',
      'notify',
      'streamer',
      'theme',
      'typing',
      'v',
    ])
  })
})

describe('applying', () => {
  const incoming = (): ConfigDoc => {
    let notify = setLevel(EMPTY_NOTIFY, { kind: 'server', name: 'club' }, 'all')
    notify = setLevel(notify, { kind: 'server', name: 'secret-base' }, 'nothing')
    notify = setMute(notify, { kind: 'dm', id: 7 }, 'forever')
    notify = setMute(notify, { kind: 'dm', id: 5 }, 'forever')
    return {
      v: 1,
      theme: 'light',
      streamer: true,
      appearOffline: true,
      layout: {
        servers: [
          'secret-base',
          { id: 'f1', name: 'Games', servers: ['club', 'arena', 'rchat'], open: true },
        ],
        dmOrder: [7, 5],
        dmPinned: [7, 5],
        selfPin: 'unpinned',
      },
      notify,
      emoji: { v: 1, tone: 4, used: { '🎉': { n: 3, at: 1, last: '🎉' } } },
    }
  }

  beforeEach(() => {
    useStore.setState({
      me: me('bob', { servers: [srv('rchat'), srv('club')] }),
      token: 'bob-token',
      guest: false,
      dms: [dm(4, 'bob', true), dm(5, 'carol')],
      dmsMore: false,
      servers: {},
      reads: {},
      layout: emptyLayout,
      notifyPrefs: EMPTY_NOTIFY,
      emoji: EMPTY_PREFS,
      theme: 'dark',
      streamer: false,
    })
  })

  test('on another account: unknown servers and DMs drop out, the rest is written to its keys', async () => {
    const error = await st().applyConfig(incoming(), [
      'theme',
      'streamer',
      'appearOffline',
      'layout',
      'notify',
      'emoji',
    ])
    expect(error).toBeNull()
    expect(st().theme).toBe('light')
    expect(st().streamer).toBe(true)
    expect(local.get('rchat_theme')).toBe('light')
    expect(st().me?.appear_offline).toBe(true)
    expect(requests.some(r => r.startsWith('PATCH ') && r.endsWith('/api/me'))).toBe(true)
    expect(st().layout.servers).toEqual([
      { id: 'f1', name: 'Games', servers: ['club', 'rchat'], open: true },
    ])
    expect(st().layout.dmPinned).toEqual([5])
    expect(st().layout.dmOrder).toEqual([5])
    expect(st().layout.selfPin).toBe('unpinned')
    const stored = JSON.parse(local.get(home.scoped(layoutKey('bob'))) ?? 'null') as {
      servers: unknown
    }
    expect(stored.servers).toEqual(st().layout.servers)
    expect(Object.keys(st().notifyPrefs.servers)).toEqual(['club'])
    expect(Object.keys(st().notifyPrefs.dms)).toEqual(['5'])
    expect(local.get(home.scoped(notifyKey('bob')))).toContain('club')
    expect((local.get(home.scoped(notifyKey('bob'))) ?? '').includes('secret-base')).toBe(false)
    expect(st().emoji.tone).toBe(4)
    expect(local.get(home.scoped(emojiKey('bob')))).toContain('🎉')
    expect(requests.some(r => r.includes('/me/servers?names='))).toBe(true)
  })

  test('only checked sections apply', async () => {
    await st().applyConfig(incoming(), ['streamer'])
    expect(st().streamer).toBe(true)
    expect(st().theme).toBe('dark')
    expect(st().layout).toBe(emptyLayout)
    expect(st().me?.appear_offline).toBe(false)
    expect(requests).toEqual([])
  })

  test('logged out: theme and streamer apply now, the rest waits for login', async () => {
    useStore.setState({ me: null, token: null, guest: false })
    await st().applyConfig(incoming(), ['theme', 'streamer', 'layout', 'notify', 'appearOffline'])
    expect(st().theme).toBe('light')
    expect(st().streamer).toBe(true)
    expect(st().layout).toBe(emptyLayout)
    expect(requests).toEqual([])
    expect(hasStashedConfig()).toBe(true)
    const saved = JSON.parse(session.get('rchat_config_stash') ?? 'null') as { keys: string[] }
    expect(saved.keys.sort()).toEqual(['appearOffline', 'layout', 'notify'])
  })
})

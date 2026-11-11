import { describe, expect, test } from 'bun:test'
import { versionedUrl } from '../api_version'
import { jwksUrl } from '../identity'
import {
  InstanceConnection,
  endpointsFrom,
  fetchInstance,
  homeEndpoints,
  type Endpoints,
} from '../instances'
import { AUTO, defaultRelays, resolveIce } from '../relays'
import type { InstanceInfo } from '../types'

// What a server with default settings says about itself at `origin`.
const documentAt = (origin: string): InstanceInfo => {
  const url = new URL(origin)
  return {
    software: 'rchat',
    id: 'abc123',
    name: 'RChat',
    host: url.host,
    version: '0.4.0',
    api_version: '1.0',
    api_versions: ['v1'],
    public_url: origin,
    api_url: `${origin}/api`,
    ws_url: `${url.protocol === 'https:' ? 'wss' : 'ws'}://${url.host}/api/ws`,
    peerjs_url: `${origin}/peerjs`,
    instance_url: `${origin}/api/instance`,
    jwks_uri: `${origin}/.well-known/jwks.json`,
    ice: { stun: [], turn: false, relay: false },
    features: { guests: true, uploads: true, previews: true, identity_assertions: true },
    limits: {
      message_chars: 4000,
      name_chars: 100,
      upload_bytes: 26214400,
      media_retention_secs: 86400,
      page_size: 50,
      assertion_ttl_secs: 300,
    },
  }
}

const pageAt = (href: string) => {
  const { protocol, host, hostname, port } = new URL(href)
  return { href, protocol, host, hostname, port }
}

// The scheme, host and port of an address the page at `page` calls.
const place = (address: string, page: string) => {
  const url = new URL(address, page)
  const secure = url.protocol === 'https:' || url.protocol === 'wss:'
  return {
    host: url.hostname,
    port: Number(url.port || (secure ? 443 : 80)),
    secure,
  }
}

// Where each kind of request of a connection goes.
const places = (ends: Endpoints, info: InstanceInfo | null, page: string) => {
  const conn = new InstanceConnection(ends, info)
  const peer = conn.peer()
  return {
    api: place(conn.apiBase, page),
    media: place(conn.api.mediaUrl('abc'), page),
    health: place(conn.health(), page),
    socket: place(versionedUrl(ends.url(), conn.api.prefix), page),
    signaling: { host: peer.host, port: peer.port, secure: peer.secure },
  }
}

const everywhere = (at: ReturnType<typeof place>) => ({
  api: at,
  media: at,
  health: at,
  socket: at,
  signaling: at,
})

describe('one address', () => {
  const pages = [
    'https://chat.example.com/',
    'https://chat.example.com:8443/login/',
    'http://127.0.0.1:3000/',
    'http://192.168.1.20:3000/s/club',
    'http://[::1]:3000/',
  ]

  test('with default settings the web app calls only the origin of its page', () => {
    for (const page of pages) {
      const origin = new URL(page).origin
      const here = everywhere(place(origin, page))
      const ends = homeEndpoints(() => pageAt(page), { peer: {} })
      expect({ page, to: places(ends, null, page) }).toEqual({ page, to: here })
      expect({ page, to: places(ends, documentAt(origin), page) }).toEqual({ page, to: here })
      // An instance without PUBLIC_URL names itself by the address of another request.
      const named = documentAt('http://127.0.0.1:3000')
      expect({ page, to: places(ends, named, page) }).toEqual({ page, to: here })
      expect(ends.origin).toBe(origin)
    }
  })

  test('paths stay the same on every origin', () => {
    const ends = homeEndpoints(() => pageAt('https://chat.example.com/login/'), { peer: {} })
    const conn = new InstanceConnection(ends, documentAt('https://chat.example.com'))
    expect(conn.apiBase).toBe('/api/v1')
    expect(conn.api.mediaUrl('abc')).toBe('/api/v1/media/abc')
    expect(conn.health()).toBe('/api/v1/health')
    expect(versionedUrl(ends.url(), 'v1')).toBe('wss://chat.example.com/api/v1/ws')
    expect(conn.peer()).toEqual({
      host: 'chat.example.com',
      port: 443,
      path: '/peerjs',
      secure: true,
    })
  })

  test('the page is asked for when an address is built', () => {
    let href: string | undefined
    const ends = homeEndpoints(() => (href === undefined ? undefined : pageAt(href)), { peer: {} })
    expect(ends.api).toBe('http://127.0.0.1:3000/api')
    href = 'https://chat.example.com/'
    expect(ends.url()).toBe('wss://chat.example.com/api/ws')
    expect(ends.peer(null)).toEqual({
      host: 'chat.example.com',
      port: 443,
      path: '/peerjs',
      secure: true,
    })
    href = 'http://127.0.0.1:3000/'
    expect(ends.url()).toBe('ws://127.0.0.1:3000/api/ws')
  })

  test('another instance is called only on its one address', () => {
    for (const origin of [
      'https://b.example',
      'https://b.example:8443',
      'http://127.0.0.1:3900',
      'http://[::1]:3900',
    ]) {
      const there = everywhere(place(origin, origin))
      for (const info of [documentAt(origin), null])
        expect({ origin, to: places(endpointsFrom(origin, info), info, origin) }).toEqual({
          origin,
          to: there,
        })
    }
  })

  test('discovery and keys are asked of the same address', async () => {
    for (const origin of ['https://b.example', 'https://b.example:8443', 'http://127.0.0.1:3900']) {
      const asked: string[] = []
      const found = await fetchInstance(origin, async input => {
        asked.push(input)
        return input.endsWith('/api/instance')
          ? new Response('', { status: 404 })
          : new Response(JSON.stringify(documentAt(origin)), {
              headers: { 'Content-Type': 'application/json' },
            })
      })
      expect(asked).toEqual([`${origin}/api/instance`, `${origin}/.well-known/rchat`])
      for (const address of [found.api_url, found.instance_url, found.jwks_uri])
        expect(new URL(address).origin).toBe(origin)
      expect(place(found.ws_url, origin)).toEqual(place(origin, origin))
      expect(place(found.peerjs_url, origin)).toEqual(place(origin, origin))
    }
    expect(jwksUrl('https://b.example').href).toBe('https://b.example/.well-known/jwks.json')
  })

  test('calls name no server of their own', () => {
    const { ice } = documentAt('https://chat.example.com')
    expect(ice).toEqual({ stun: [], turn: false, relay: false })
    const resolved = resolveIce(AUTO, defaultRelays(), {
      instance: [],
      helpers: true,
      relayOnly: false,
      instanceTurn: false,
      forced: null,
    })
    expect(resolved).toEqual({
      ok: true,
      config: { iceServers: [] },
      declared: [],
      manual: null,
    })
  })
})

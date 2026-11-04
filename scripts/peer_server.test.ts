import { afterEach, describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Server } from 'node:http'
import {
  bucketOf,
  clientOf,
  perAddress,
  proxyList,
  setting,
  start,
} from '../deploy/peer/server.mjs'

const read = (path: string) => readFileSync(join(import.meta.dir, '..', path), 'utf8')

const req = (remote: string, xff?: string) => ({
  socket: { remoteAddress: remote },
  headers: xff === undefined ? {} : { 'x-forwarded-for': xff },
})

describe('PeerJS per-address limit', () => {
  test('IPv4 addresses count alone, IPv6 per /64', () => {
    expect(bucketOf('203.0.113.7')).toBe('203.0.113.7')
    expect(bucketOf('::ffff:203.0.113.7')).toBe('203.0.113.7')
    expect(bucketOf('2001:db8:1:2:aaaa::1')).toBe('2001:db8:1:2::/64')
    expect(bucketOf('2001:db8:1:2:ffff:ffff:ffff:ffff')).toBe('2001:db8:1:2::/64')
    expect(bucketOf('2001:0db8:0001:0002::9')).toBe('2001:db8:1:2::/64')
    expect(bucketOf('2001:db8::1')).toBe('2001:db8:0:0::/64')
    expect(bucketOf('::1')).toBe('0:0:0:0::/64')
  })

  test('X-Forwarded-For counts only from trusted proxies', () => {
    const trusted = proxyList('10.0.0.0/8, 192.0.2.10')
    expect(clientOf(req('198.51.100.1', '203.0.113.9'), trusted, false)).toBe('198.51.100.1')
    expect(clientOf(req('10.1.2.3', '203.0.113.9'), trusted, false)).toBe('203.0.113.9')
    expect(clientOf(req('::ffff:192.0.2.10', 'x, 203.0.113.9'), trusted, false)).toBe('203.0.113.9')
    expect(clientOf(req('10.1.2.3', 'not-an-ip'), trusted, false)).toBe('10.1.2.3')
    expect(clientOf(req('10.1.2.3'), trusted, false)).toBe('10.1.2.3')
    expect(clientOf(req('198.51.100.1', '203.0.113.9'), proxyList(''), true)).toBe('203.0.113.9')
    expect(() => proxyList('example.com')).toThrow()
  })

  test('slots per bucket, 0 for no limit', () => {
    const held = perAddress(2)
    expect([held.take('a'), held.take('a'), held.take('a'), held.take('b')]).toEqual([
      true,
      true,
      false,
      true,
    ])
    held.give('a')
    expect(held.take('a')).toBe(true)
    held.give('a')
    held.give('a')
    held.give('b')
    expect(held.size()).toBe(0)
    const open = perAddress(0)
    for (let i = 0; i < 100; i++) expect(open.take('a')).toBe(true)
    expect(setting({}, 'X', 7)).toBe(7)
    expect(setting({ X: '12' }, 'X', 7)).toBe(12)
    expect(() => setting({ X: '-1' }, 'X', 7)).toThrow()
    expect(() => setting({ X: 'ten' }, 'X', 7)).toThrow()
  })

  let server: Server | null = null
  afterEach(() => {
    server?.close()
    server = null
  })

  test('a live server refuses connections past the limit and frees them on close', async () => {
    const got = await start({ PEERJS_PORT: '0', PEERJS_PEERS_PER_IP: '3' })
    server = got.server
    const addr = server.address()
    const port = typeof addr === 'object' && addr ? addr.port : 0
    const open = (id: string) =>
      new Promise<WebSocket | null>(resolve => {
        const ws = new WebSocket(
          `ws://127.0.0.1:${port}/peerjs/peerjs?key=peerjs&id=${id}&token=t${id}`
        )
        ws.onmessage = e => {
          if (String(e.data).includes('"OPEN"')) resolve(ws)
        }
        ws.onerror = () => resolve(null)
        ws.onclose = () => resolve(null)
      })
    const first = await Promise.all(['a1', 'a2', 'a3'].map(open))
    expect(first.every(ws => ws !== null)).toBe(true)
    expect(await open('a4')).toBeNull()
    expect(got.held.size()).toBe(1)
    first[0]?.close()
    for (let i = 0; i < 100 && !got.held.room('127.0.0.1'); i++) await Bun.sleep(10)
    const again = await open('a5')
    expect(again).not.toBeNull()
    for (const ws of [...first, again]) ws?.close()
  })

  test('every deploy runs the limited server with its settings', () => {
    const start = read('deploy/start.sh')
    expect(start).toContain('bun server.mjs')
    expect(start).not.toContain('bunx peer')
    expect(read('Dockerfile')).toContain('deploy/peer/server.mjs')
    expect(read('deploy/k8s/peerjs.yaml')).toContain('rchat-config')
    const compose = read('deploy/compose.scale.yml')
    const peerjs = compose.slice(compose.indexOf('\n  peerjs:'), compose.indexOf('\n  nginx:'))
    expect(peerjs).toContain('TRUSTED_PROXIES: ${RCHAT_EDGE_SUBNET')
    const nginx = read('deploy/nginx.conf')
    expect(nginx).toContain('limit_conn_zone $binary_remote_addr zone=peers')
    expect(nginx.split('limit_conn peers ').length - 1).toBe(2)
    const env = read('.env.local.example')
    expect(env).toContain('# PEERJS_PEERS_PER_IP=50')
    expect(env).toContain('# PEERJS_CONCURRENT_LIMIT=5000')
  })

  test('nginx shared memory zones have distinct names', () => {
    const nginx = read('deploy/nginx.conf')
    const names = [
      ...[...nginx.matchAll(/limit_(?:req|conn)_zone\s[^;]*zone=([^:\s]+):/g)].map(m => m[1]),
      ...[...nginx.matchAll(/^\s*zone\s+(\S+)\s+\S+;/gm)].map(m => m[1]),
    ]
    expect(names.length).toBeGreaterThan(5)
    expect(names.filter((name, i) => names.indexOf(name) !== i)).toEqual([])
  })
})

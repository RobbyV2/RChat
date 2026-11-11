import { afterEach, describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Server } from 'node:http'
import {
  bucketOf,
  clientOf,
  perAddress,
  proxyList,
  setting,
  start,
  wanted,
} from '../deploy/peer/server.mjs'

const repo = join(import.meta.dir, '..')

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
    expect(nginx.split('limit_conn peers ').length - 1).toBe(1)
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

describe('one public port by default', () => {
  test('the separate PeerJS server is wanted only when the settings name one', () => {
    expect(wanted({})).toBe(false)
    expect(wanted({ PEERJS_BUILTIN: '', PEERJS_PORT: ' ', PUBLIC_PEERJS_URL: '' })).toBe(false)
    for (const on of ['on', 'true', 'yes', '1', ' ON '])
      expect(wanted({ PEERJS_BUILTIN: on })).toBe(false)
    for (const off of ['off', 'false', 'no', '0', ' Off ', 'FALSE'])
      expect(wanted({ PEERJS_BUILTIN: off })).toBe(true)
    expect(wanted({ PEERJS_PORT: '9001' })).toBe(true)
    expect(wanted({ PUBLIC_PEERJS_URL: 'https://chat.example.com/peerjs' })).toBe(true)
    // A web build that names its own PeerJS port or host dials the separate server.
    expect(wanted({ NEXT_PUBLIC_PEERJS_PORT: '443' })).toBe(true)
    expect(wanted({ NEXT_PUBLIC_PEERJS_HOST: 'peer.example.com' })).toBe(true)
    expect(wanted({ NEXT_PUBLIC_PEERJS_PORT: '', NEXT_PUBLIC_PEERJS_HOST: ' ' })).toBe(false)
    expect(wanted({ PEERJS_PEERS_PER_IP: '50', PEERJS_CONCURRENT_LIMIT: '5000' })).toBe(false)
    const asked = (env: Record<string, string>) =>
      spawnSync(process.execPath, [join(repo, 'deploy/peer/server.mjs'), '--wanted'], {
        env: { PATH: process.env.PATH ?? '', ...env },
        timeout: 60_000,
      })
    const no = asked({})
    expect([no.status, no.stdout.toString(), no.stderr.toString()]).toEqual([1, '', ''])
    expect(asked({ PEERJS_PORT: '9001' }).status).toBe(0)
  }, 120_000)

  // deploy/start.sh with `bun` and `./server` replaced by scripts that write down what ran.
  const started = (env: Record<string, string>, arg = '') => {
    const dir = mkdtempSync(join(tmpdir(), 'rchat-start-'))
    try {
      mkdirSync(join(dir, 'bin'))
      mkdirSync(join(dir, 'peer'))
      const log = join(dir, 'log')
      writeFileSync(log, '')
      writeFileSync(
        join(dir, 'bin', 'bun'),
        [
          '#!/bin/sh',
          `if [ "$2" = "--wanted" ]; then exec "${process.execPath}" "${repo}/deploy/peer/server.mjs" --wanted; fi`,
          `echo "bun $*" >> "${log}"`,
          'exec sleep 20 < /dev/null > /dev/null 2>&1',
          '',
        ].join('\n'),
        { mode: 0o755 }
      )
      writeFileSync(join(dir, 'server'), `#!/bin/sh\nsleep 2\necho server >> "${log}"\n`, {
        mode: 0o755,
      })
      const script = [
        `cd() { case "$1" in /app/peer) command cd "${dir}/peer" ;; *) command cd "$@" ;; esac; }`,
        arg ? `set -- ${arg}` : 'set --',
        `. "${repo}/deploy/start.sh"`,
      ].join('\n')
      const run = spawnSync('sh', ['-c', script], {
        cwd: dir,
        env: { PATH: `${join(dir, 'bin')}:/usr/bin:/bin`, ...env },
        timeout: 15_000,
      })
      const ran = readFileSync(log, 'utf8').split('\n').filter(Boolean).sort()
      return { ran, status: run.status }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }
  const api = { APP_MODE: 'api-only' }
  const PEER = 'bun server.mjs'

  test('the image starts only the server unless the settings ask for the PeerJS server', () => {
    expect(started(api)).toEqual({ ran: ['server'], status: 0 })
    expect(started({}).ran).toEqual(['bun server.js', 'server'])
    expect(started({ ...api, PEERJS_PEERS_PER_IP: '9' }).ran).toEqual(['server'])
    // An instance from before the built-in signaling: its own port or address keeps its server.
    expect(started({ ...api, PEERJS_PORT: '9100' }).ran).toEqual([PEER, 'server'])
    expect(started({ ...api, PUBLIC_PEERJS_URL: 'https://chat.example.com/peerjs' }).ran).toEqual([
      PEER,
      'server',
    ])
    expect(started({ ...api, PEERJS_BUILTIN: 'false' }).ran).toEqual([PEER, 'server'])
    // An image whose web build was given its own PeerJS port or host carries that setting.
    expect(started({ ...api, NEXT_PUBLIC_PEERJS_PORT: '443' }).ran).toEqual([PEER, 'server'])
    expect(started({ ...api, NEXT_PUBLIC_PEERJS_HOST: 'peer.example.com' }).ran).toEqual([
      PEER,
      'server',
    ])
    expect(
      started({ ...api, NEXT_PUBLIC_PEERJS_PORT: '', NEXT_PUBLIC_PEERJS_HOST: '' }).ran
    ).toEqual(['server'])
    // RCHAT_PEERJS says it outright.
    expect(started({ ...api, RCHAT_PEERJS: 'on' }).ran).toEqual([PEER, 'server'])
    expect(started({ ...api, RCHAT_PEERJS: 'off', PEERJS_PORT: '9100' }).ran).toEqual(['server'])
    // A process with only some roles never starts it: the peer role is its own container.
    expect(started({ RCHAT_ROLES: 'api,gateway', PEERJS_BUILTIN: 'false' }).ran).toEqual(['server'])
    expect(started({ RCHAT_ROLES: 'web', PEERJS_PORT: '9100' }).ran).toEqual([
      'bun server.js',
      'server',
    ])
    expect(started({ RCHAT_ROLES: 'all', PEERJS_PORT: '9100' }).ran).toEqual([
      'bun server.js',
      PEER,
      'server',
    ])
  }, 240_000)

  test('nothing starts, publishes or names the PeerJS port without being asked', () => {
    const recipes = read('jfiles/src/run.just')
    const peerLines = recipes.split('\n').filter(line => line.includes('deploy/peer/server.mjs'))
    expect(peerLines.length).toBe(3)
    for (const line of peerLines)
      expect(line).toContain(
        "bun deploy/peer/server.mjs --wanted && exec bun deploy/peer/server.mjs'"
      )
    expect(read('deploy/start.sh')).toContain('bun server.mjs --wanted')
    const expose = read('Dockerfile')
      .split('\n')
      .filter(line => line.startsWith('EXPOSE'))
    expect(expose).toEqual(['EXPOSE 3000 3478/udp 49160-49415/udp'])
    // The image remembers the PeerJS address its web build was given, for start.sh to see.
    const runtime = read('Dockerfile').split('# Stage 5: Runtime')[1]
    for (const name of ['NEXT_PUBLIC_PEERJS_HOST', 'NEXT_PUBLIC_PEERJS_PORT']) {
      expect(runtime).toContain(`ARG ${name}\n`)
      expect(runtime).toContain(`${name}=\${${name}}`)
    }
    expect(read('docker-compose.yml')).not.toContain('9001')
    expect(read('.env.local.example')).toContain('# PEERJS_BUILTIN=true')
    // The scaled setups keep the PeerJS role behind the one HTTP port.
    const compose = read('deploy/compose.scale.yml')
    expect(compose).toContain('PEERJS_BUILTIN: "false"')
    expect(compose).toContain('command: ["/app/start.sh", "peer"]')
    expect(compose).not.toContain(':9001"')
    expect(read('deploy/k8s/config.yaml')).toContain('PEERJS_BUILTIN: "false"')
    const nginx = read('deploy/nginx.conf')
    expect(nginx).toContain('location /peerjs {')
    expect(nginx).not.toContain('listen 9001')
    expect(nginx.split('listen ').length - 1).toBe(1)
  })
})

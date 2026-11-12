import { afterAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { fromBinary, toBinary, create } from '@bufbuild/protobuf'
import { createHash, createPublicKey, verify } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  CallHeadSchema,
  RefusalReason,
  RefusalSchema,
} from '../apps/web/app/lib/fed/gen/rchat/fed/v1/call_pb'
import {
  DELIVER,
  HELLO,
  PREVIEW,
  keyServer,
  refusal,
  run,
  signCall,
  signerOf,
  stampFor,
  stampTarget,
  stampWins,
  verdict,
  type Config,
} from './load/fed'

setDefaultTimeout(120_000)

const vectors = JSON.parse(
  readFileSync(join(import.meta.dir, '..', 'crates/fed/tests/vectors/fed.json'), 'utf8')
)
const hex = (b: Uint8Array) => Buffer.from(b).toString('hex')
const AUD = 'https://target.load.test'

describe('calls in the model format', () => {
  test('a signed call is the vector: head, signature and authorization', () => {
    const signer = signerOf('a.example', new Uint8Array(32).fill(7))
    expect(signer.kid).toBe(vectors.key.kid)
    expect(signer.x).toBe(vectors.key.public)
    const call = signCall(
      { ...signer, instanceId: '00112233445566778899aabbccddeeff', helloRev: 1n },
      'https://b.example',
      DELIVER,
      Buffer.from(vectors.call.body, 'hex'),
      vectors.call.now,
      new Uint8Array(16).fill(0x11)
    )
    expect(hex(call.head)).toBe(vectors.call.head)
    expect(hex(call.sig)).toBe(vectors.call.sig)
    expect(call.authorization).toBe(vectors.call.authorization)
  })

  test('a stamp wins every puzzle over a seed bound to callee, caller, jti and time', () => {
    expect(stampTarget(16, 2 ** 20)).toBe(2n ** 48n)
    expect(stampTarget(1, 1)).toBe(2n ** 64n - 1n)
    const jti = new Uint8Array(16).fill(3)
    const stamp = stampFor(AUD, 'https://a.load.test', jti, 1_800_000_000n, 64, 4)
    expect(stamp.length).toBe(32)
    expect(stampWins(stamp, AUD, 'https://a.load.test', jti, 1_800_000_000n, 64, 4)).toBe(true)
    expect(stampWins(stamp, AUD, 'https://b.load.test', jti, 1_800_000_000n, 64, 4)).toBe(false)
    expect(stampWins(stamp, AUD, 'https://a.load.test', jti, 1_800_000_001n, 64, 4)).toBe(false)
  })
})

type Fake = { url: string; stop: () => void; fetches: () => number }

const unb64u = (s: string) => new Uint8Array(Buffer.from(s, 'base64url'))

// A callee that keeps the order of the model's checks, with small budgets so a one-second run
// reaches each answer.
const fakeTarget = (keysUrl: string, opts: { verify?: boolean; pause?: boolean } = {}): Fake => {
  const keys = new Map<string, Map<string, Buffer>>()
  const seen = new Set<string>()
  const stamps = new Set<string>()
  const perNetwork = new Map<string, number>()
  const networkCalls = new Map<string, number[]>()
  let fetches = 0
  const refuse = (http: number, code: string, reason?: RefusalReason, extra: object = {}) => {
    const details =
      reason === undefined
        ? {}
        : {
            details: [
              {
                type: 'rchat.fed.v1.Refusal',
                value: Buffer.from(
                  toBinary(RefusalSchema, create(RefusalSchema, { reason, ...extra }))
                )
                  .toString('base64')
                  .replace(/=+$/, ''),
              },
            ],
          }
    return new Response(JSON.stringify({ code, ...details }), {
      status: http,
      headers: { 'content-type': 'application/json', 'retry-after': '1' },
    })
  }
  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    async fetch(req) {
      const path = new URL(req.url).pathname.replace(/^\/fed/, '')
      const body = new Uint8Array(await req.arrayBuffer())
      const auth = req.headers.get('authorization') ?? ''
      const [head64, sig64] = auth.replace(/^RChat-Fed /, '').split('.')
      if (!auth.startsWith('RChat-Fed ') || !sig64) return refuse(404, 'not_found')
      const headBytes = unb64u(head64)
      const head = fromBinary(CallHeadSchema, headBytes)
      const now = Math.floor(Date.now() / 1000)
      if (head.aud !== AUD) return refuse(404, 'not_found')
      if (![HELLO, DELIVER, PREVIEW].includes(path)) return refuse(501, 'unimplemented')
      if (head.method !== path || Math.abs(Number(head.iat) - now) > 30)
        return refuse(401, 'unauthenticated')
      if (hex(head.bodySha256) !== createHash('sha256').update(body).digest('hex'))
        return refuse(401, 'unauthenticated')
      const network = (req.headers.get('x-forwarded-for') ?? '').split('.').slice(0, 3).join('.')
      let known = keys.get(head.iss)
      if (!known) {
        if (path !== HELLO) return refuse(401, 'unauthenticated')
        const jti = hex(head.jti)
        const stamped =
          head.stamp.length > 0 &&
          stampWins(head.stamp, head.aud, head.iss, head.jti, head.iat, 64, 4) &&
          !stamps.has(jti)
        if (stamped) stamps.add(jti)
        const used = perNetwork.get(network) ?? 0
        if (!stamped && used >= 5) return refuse(503, 'unavailable')
        if (!stamped && fetches >= 12)
          return refuse(503, 'unavailable', RefusalReason.STAMP_NEEDED, { stampWork: 64n })
        fetches += 1
        perNetwork.set(network, used + 1)
        const host = head.iss.replace('https://', '')
        const jwks = await fetch(`${keysUrl}/.well-known/jwks.json?host=${host}`)
        if (!jwks.ok) return refuse(503, 'unavailable')
        const doc = (await jwks.json()) as { keys: { kid: string; x: string }[] }
        known = new Map(doc.keys.map(k => [k.kid, Buffer.from(k.x, 'base64url')]))
        keys.set(head.iss, known)
      }
      const raw = known.get(head.kid)
      if (!raw) return refuse(401, 'unauthenticated')
      const pub = createPublicKey({
        key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), raw]),
        format: 'der',
        type: 'spki',
      })
      const signed = Buffer.concat([Buffer.from('rchat-fed-call1\u0000'), headBytes])
      if (opts.verify !== false && !verify(null, signed, pub, unb64u(sig64)))
        return refuse(401, 'unauthenticated')
      const replay = `${head.iss} ${hex(head.jti)}`
      if (seen.has(replay)) return refuse(401, 'unauthenticated')
      seen.add(replay)
      if (opts.pause && head.iss.startsWith('https://h1.'))
        return refuse(503, 'unavailable', RefusalReason.PAUSED, { until: BigInt(now + 3600) })
      const recent = (networkCalls.get(network) ?? []).filter(t => t > Date.now() - 10_000)
      recent.push(Date.now())
      networkCalls.set(network, recent)
      if (recent.length > 40)
        return refuse(503, 'unavailable', RefusalReason.BUSY, { until: BigInt(now + 1) })
      return new Response(new Uint8Array(), { headers: { 'content-type': 'application/proto' } })
    },
  })
  return {
    url: `http://127.0.0.1:${server.port}`,
    stop: () => server.stop(true),
    fetches: () => fetches,
  }
}

const config = (base: string, keysPort: number): Config => ({
  base,
  aud: AUD,
  suffix: 'load.test',
  allowRemote: false,
  keysHost: '127.0.0.1',
  keysPort,
  hosts: 4,
  rate: 60,
  seconds: 1,
  minted: 1800,
  networks: 3,
  stamped: 120,
  neighbour: 80,
  stampWork: 64,
  stampPuzzles: 4,
})

describe('the guard against a real target', () => {
  const at = (base: string, suffix = 'load.test', allowRemote = false) =>
    refusal({ base, suffix, allowRemote })

  test('a loopback or private target is taken, any other only when asked for', () => {
    for (const base of [
      'http://localhost:3400',
      'http://app.localhost',
      'http://127.0.0.1:3400',
      'http://127.9.9.9',
      'http://[::1]:3400',
      'http://10.1.2.3',
      'http://172.16.0.1',
      'http://172.31.255.255',
      'http://192.168.1.20:8080',
      'http://[fd12:3456::1]',
    ])
      expect({ base, refused: at(base) }).toEqual({ base, refused: null })
    for (const base of [
      'https://chat.example.com',
      'https://target.load.test',
      'http://203.0.113.5',
      'http://172.32.0.1',
      'http://172.15.0.1',
      'http://192.169.1.1',
      'http://11.0.0.1',
      'http://[2001:db8::1]',
      'http://localhost.example.com',
      'not a url',
    ]) {
      expect({ base, refused: at(base) }).toEqual({
        base,
        refused: 'BASE must be a loopback or private address. Set FED_ALLOW_REMOTE=1 to allow it.',
      })
      expect({ base, refused: at(base, 'load.test', true) }).toEqual({ base, refused: null })
    }
  })

  test('simulated hosts only ever get names under a reserved test domain', () => {
    for (const suffix of ['load.test', 'test', 'a.example', 'x.invalid', 'fed.localhost', 'A.TEST'])
      expect({ suffix, refused: at('http://127.0.0.1', suffix) }).toEqual({ suffix, refused: null })
    for (const suffix of ['example.com', 'attacker.net', 'contest', 'test.org', 'load.test.', ''])
      for (const allowRemote of [false, true])
        expect({ suffix, refused: at('http://127.0.0.1', suffix, allowRemote) }).toEqual({
          suffix,
          refused: 'FED_SUFFIX must end in .test, .example, .invalid or .localhost.',
        })
  })

  test('a refused run sends nothing and starts no key server', async () => {
    const cfg = config('http://203.0.113.5', 0)
    await expect(run(cfg)).rejects.toThrow('FED_ALLOW_REMOTE')
    await expect(run({ ...cfg, base: 'http://127.0.0.1', suffix: 'example.com' })).rejects.toThrow(
      'FED_SUFFIX'
    )
    const script = join(import.meta.dir, 'load/fed.ts')
    const { OUT: _out, FED_ALLOW_REMOTE: _allow, FED_SUFFIX: _suffix, ...env } = process.env
    const proc = Bun.spawn([process.execPath, script], {
      env: { ...env, BASE: 'http://203.0.113.5', FED_KEYS_PORT: '0' },
      stdout: 'pipe',
      stderr: 'pipe',
    })
    expect(await proc.exited).toBe(2)
    expect(await new Response(proc.stderr).text()).toBe(
      'BASE must be a loopback or private address. Set FED_ALLOW_REMOTE=1 to allow it.\n'
    )
    expect(await new Response(proc.stdout).text()).toBe('')
  })

  test('the key server listens on loopback unless told otherwise', () => {
    const keys = keyServer(0)
    expect(keys.hostname).toBe('127.0.0.1')
    keys.stop()
  })
})

describe('the load run against a fake target', () => {
  const stops: (() => void)[] = []
  afterAll(() => stops.forEach(stop => stop()))

  const rig = (opts: { verify?: boolean; pause?: boolean } = {}) => {
    const keys = keyServer(0)
    const target = fakeTarget(`http://127.0.0.1:${keys.port}`, opts)
    stops.push(target.stop, () => keys.stop())
    return { target, keys, cfg: config(target.url, keys.port) }
  }

  test('the key server answers for the simulated hosts only', async () => {
    const { keys } = rig()
    keys.add(signerOf('h0.load.test'))
    const url = `http://127.0.0.1:${keys.port}/.well-known/jwks.json`
    const doc = await (await fetch(`${url}?host=h0.load.test`)).json()
    expect(doc).toEqual({
      keys: [
        {
          kty: 'OKP',
          crv: 'Ed25519',
          x: signerOf('h0.load.test').x,
          kid: signerOf('h0.load.test').kid,
          alg: 'EdDSA',
          use: 'sig',
        },
      ],
    })
    expect((await fetch(url, { headers: { 'x-forwarded-host': 'h0.load.test' } })).status).toBe(200)
    expect((await fetch(`${url}?host=other.example`)).status).toBe(404)
    expect((await fetch(`http://127.0.0.1:${keys.port}/else?host=h0.load.test`)).status).toBe(404)
  })

  test('honest calls pass, forged and stale ones get 401, a newcomer gets through with one stamp', async () => {
    const { cfg, target, keys } = rig()
    const report = await run(cfg, keys)
    const by = (kind: keyof typeof report.kinds) => Object.fromEntries(report.kinds[kind].by)
    expect(Object.keys(by('honest'))).toEqual(['200'])
    expect(by('honest')['200']).toBeGreaterThanOrEqual(50)
    expect(Object.keys(by('forged'))).toEqual(['401'])
    expect(Object.keys(by('stale'))).toEqual(['401'])
    expect(by('forged')['401']).toBeGreaterThan(3)
    expect(by('stale')['401']).toBeGreaterThan(3)
    expect(by('newcomer')).toEqual({ '503 STAMP_NEEDED': 1, '200': 1 })
    expect(report.stamps).toBeGreaterThanOrEqual(1)
    const minted = by('minted')
    expect(Object.keys(minted).every(k => ['200', '503', '503 STAMP_NEEDED'].includes(k))).toBe(
      true
    )
    expect(minted['200']).toBeGreaterThan(0)
    expect((minted['503'] ?? 0) + (minted['503 STAMP_NEEDED'] ?? 0)).toBeGreaterThan(0)
    const pressed = by('pressed')
    expect(pressed['503 BUSY']).toBeGreaterThan(0)
    expect(pressed.held).toBeGreaterThan(0)
    expect(Object.keys(pressed).every(k => ['200', '503 BUSY', 'held'].includes(k))).toBe(true)
    expect(verdict(report)).toEqual([])
    expect(target.fetches()).toBeLessThan(40)
    expect(report.lines.map(l => l.split(':')[0])).toEqual([
      'fed honest',
      'fed forged',
      'fed stale',
      'fed minted',
      'fed neighbour',
      'fed pressed',
      'fed newcomer',
    ])
    expect(report.lines[0]).toMatch(
      /^fed honest: n=\d+ p50=[\d.]+ms p99=[\d.]+ms max=[\d.]+ms 200=\d+ /
    )
  })

  test('a target that takes forged calls fails the run', async () => {
    const { cfg, keys } = rig({ verify: false })
    const failures = verdict(await run({ ...cfg, minted: 0, neighbour: 0 }, keys))
    expect(failures.some(f => f.startsWith('forged: '))).toBe(true)
    expect(failures.join('\n')).toContain('200')
  })

  test('a target that pauses an honest host fails the run', async () => {
    const { cfg, keys } = rig({ pause: true })
    const failures = verdict(await run({ ...cfg, minted: 0, neighbour: 0 }, keys))
    expect(failures).toContain('honest: 503 PAUSED')
  })
})

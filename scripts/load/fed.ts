// Load on the instance protocol: signed calls from simulated instances against one target.
// Honest hosts say Hello and then call at FED_RATE; beside them run forged and stale calls,
// minted hosts saying Hello, a neighbour filling one network, and a newcomer under pressure.
// The run fails when an honest call is refused or a forged or stale one is taken.
import { create, fromBinary, toBinary } from '@bufbuild/protobuf'
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  randomBytes,
  sign,
  type KeyObject,
} from 'node:crypto'
import {
  CallHeadSchema,
  RefusalReason,
  RefusalSchema,
} from '../../apps/web/app/lib/fed/gen/rchat/fed/v1/call_pb'
import { HelloRequestSchema } from '../../apps/web/app/lib/fed/gen/rchat/fed/v1/instance_pb'
import { PreviewRequestSchema } from '../../apps/web/app/lib/fed/gen/rchat/fed/v1/invites_pb'
import { DeliverRequestSchema } from '../../apps/web/app/lib/fed/gen/rchat/fed/v1/letters_pb'
import { finish, header, log, need, stats } from './lib'

export const HELLO = '/rchat.fed.v1.InstanceService/Hello'
export const DELIVER = '/rchat.fed.v1.LettersService/Deliver'
export const PREVIEW = '/rchat.fed.v1.InvitesService/Preview'

const CALL_TAG = Buffer.from('rchat-fed-call1\u0000')
const STAMP_TAG = Buffer.from('rchat-fed-stamp1\u0000')
const JWKS_PATH = '/.well-known/jwks.json'
const FEATURES = [
  'core',
  'letters',
  'letters.files',
  'letters.keys',
  'invites',
  'profiles',
  'reports',
  'directory',
]

const b64u = (b: Uint8Array) => Buffer.from(b).toString('base64url')
const sha256 = (...parts: Uint8Array[]) => {
  const hash = createHash('sha256')
  for (const part of parts) hash.update(part)
  return hash.digest()
}

export type Signer = {
  host: string
  origin: string
  key: KeyObject
  x: string
  kid: string
  instanceId: string
  helloRev: bigint
}

export const signerOf = (
  host: string,
  seed: Uint8Array = sha256(Buffer.from(`rchat-load-fed\u0000${host}`))
): Signer => {
  const key = createPrivateKey({
    key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), seed]),
    format: 'der',
    type: 'pkcs8',
  })
  const x = b64u(createPublicKey(key).export({ format: 'der', type: 'spki' }).subarray(12))
  return {
    host,
    origin: `https://${host}`,
    key,
    x,
    kid: b64u(sha256(Buffer.from(`{"crv":"Ed25519","kty":"OKP","x":"${x}"}`))),
    instanceId: sha256(Buffer.from(host)).toString('hex').slice(0, 32),
    helloRev: 1n,
  }
}

export const signCall = (
  s: Pick<Signer, 'key' | 'kid' | 'origin' | 'instanceId' | 'helloRev'>,
  aud: string,
  method: string,
  body: Uint8Array,
  now: number,
  jti: Uint8Array,
  stamp: Uint8Array = new Uint8Array()
) => {
  const head = toBinary(
    CallHeadSchema,
    create(CallHeadSchema, {
      iss: s.origin,
      aud,
      method,
      iat: BigInt(now),
      exp: BigInt(now + 60),
      jti,
      bodySha256: sha256(body),
      bodyLen: BigInt(body.length),
      kid: s.kid,
      instanceId: s.instanceId,
      helloRev: s.helloRev,
      stamp,
    })
  )
  const sig = new Uint8Array(sign(null, Buffer.concat([CALL_TAG, head]), s.key))
  return { authorization: `RChat-Fed ${b64u(head)}.${b64u(sig)}`, head, sig }
}

const le8 = (n: bigint) => {
  const b = Buffer.alloc(8)
  b.writeBigUInt64LE(n)
  return b
}
const be8 = (n: bigint) => {
  const b = Buffer.alloc(8)
  b.writeBigUInt64BE(n)
  return b
}

export const stampTarget = (k: number, work: number) => {
  const t = (BigInt(k) << 64n) / BigInt(Math.max(work, k, 1))
  const max = (1n << 64n) - 1n
  return t < 1n ? 1n : t > max ? max : t
}

const stampSeed = (aud: string, iss: string, jti: Uint8Array, iat: bigint) =>
  sha256(
    STAMP_TAG,
    Buffer.from(aud),
    Buffer.from([0]),
    Buffer.from(iss),
    Buffer.from([0]),
    jti,
    be8(iat)
  )

const wins = (seed: Buffer, puzzle: number, nonce: bigint, target: bigint) =>
  sha256(Buffer.from('rchat-pow1'), seed, Buffer.from([puzzle]), le8(nonce)).readBigUInt64BE(0) <
  target

export const stampFor = (
  aud: string,
  iss: string,
  jti: Uint8Array,
  iat: bigint,
  work: number,
  k = 16
) => {
  const seed = stampSeed(aud, iss, jti, iat)
  const target = stampTarget(k, work)
  const nonces = Array.from({ length: k }, (_, puzzle) => {
    let nonce = 0n
    while (!wins(seed, puzzle, nonce, target)) nonce += 1n
    return le8(nonce)
  })
  return new Uint8Array(Buffer.concat(nonces))
}

export const stampWins = (
  stamp: Uint8Array,
  aud: string,
  iss: string,
  jti: Uint8Array,
  iat: bigint,
  work: number,
  k = 16
) => {
  if (stamp.length !== 8 * k) return false
  const seed = stampSeed(aud, iss, jti, iat)
  const target = stampTarget(k, work)
  const bytes = Buffer.from(stamp)
  return Array.from({ length: k }, (_, i) => i).every(i =>
    wins(seed, i, bytes.readBigUInt64LE(8 * i), target)
  )
}

export const keyServer = (port: number, hostname = '127.0.0.1') => {
  const signers = new Map<string, Signer>()
  const server = Bun.serve({
    port,
    hostname,
    fetch(req) {
      const url = new URL(req.url)
      const host =
        url.searchParams.get('host') ??
        req.headers.get('x-forwarded-host') ??
        (req.headers.get('host') ?? '').split(':')[0]
      const signer = signers.get(host)
      if (url.pathname !== JWKS_PATH || !signer) return new Response('Not found', { status: 404 })
      const { x, kid } = signer
      return Response.json({
        keys: [{ kty: 'OKP', crv: 'Ed25519', x, kid, alg: 'EdDSA', use: 'sig' }],
      })
    },
  })
  return {
    port: server.port ?? port,
    hostname: server.hostname ?? hostname,
    add: (signer: Signer) => void signers.set(signer.host, signer),
    stop: () => server.stop(true),
  }
}

export type KeyServer = ReturnType<typeof keyServer>

export type Config = {
  base: string
  aud: string
  suffix: string
  allowRemote: boolean
  keysHost: string
  keysPort: number
  hosts: number
  rate: number
  seconds: number
  minted: number
  networks: number
  stamped: number
  neighbour: number
  stampWork: number
  stampPuzzles: number
}

const RESERVED = ['test', 'example', 'invalid', 'localhost']

const local = (base: string) => {
  if (!URL.canParse(base)) return false
  const host = new URL(base).hostname.replace(/^\[|\]$/g, '')
  if (host === 'localhost' || host.endsWith('.localhost') || host === '::1') return true
  if (/^f[cd][0-9a-f]{2}:/.test(host)) return true
  const [a, b] = (host.match(/^(\d+)\.(\d+)\.\d+\.\d+$/) ?? []).slice(1).map(Number)
  return a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)
}

export const refusal = ({
  base,
  suffix,
  allowRemote,
}: Pick<Config, 'base' | 'suffix' | 'allowRemote'>) => {
  const name = suffix.toLowerCase()
  if (!RESERVED.some(tld => name === tld || name.endsWith(`.${tld}`)))
    return 'FED_SUFFIX must end in .test, .example, .invalid or .localhost.'
  if (!allowRemote && !local(base))
    return 'BASE must be a loopback or private address. Set FED_ALLOW_REMOTE=1 to allow it.'
  return null
}

const KINDS = ['honest', 'forged', 'stale', 'minted', 'neighbour', 'pressed', 'newcomer'] as const
export type Kind = (typeof KINDS)[number]
type Tally = { ms: number[]; by: Map<string, number> }
export type Report = { kinds: Record<Kind, Tally>; stamps: number; lines: string[] }

const bodyOf = (s: Signer, method: string) =>
  method === HELLO
    ? toBinary(
        HelloRequestSchema,
        create(HelloRequestSchema, {
          caller: {
            software: 'rchat',
            version: '0.9.0',
            instanceId: s.instanceId,
            origin: s.origin,
            name: s.host,
            majors: [1],
            features: FEATURES.map(name => ({ name, level: 1, min: 1 })),
            rev: s.helloRev,
            callKids: [s.kid],
          },
        })
      )
    : method === DELIVER
      ? toBinary(DeliverRequestSchema, create(DeliverRequestSchema, { bundle: randomBytes(16) }))
      : toBinary(PreviewRequestSchema, create(PreviewRequestSchema, { server: 'load' }))

type Answer = {
  label: string
  ms: number
  retryAfter: number
  refusal: RefusalReason
  work: number
}

const refusalOf = (text: string) => {
  try {
    const details = (JSON.parse(text) as { details?: { type?: string; value?: string }[] }).details
    const value = details?.find(d => d.type === 'rchat.fed.v1.Refusal')?.value
    return value ? fromBinary(RefusalSchema, Buffer.from(value, 'base64')) : null
  } catch {
    return null
  }
}

type Shot = {
  network: string
  skew?: number
  forge?: KeyObject
  stamp?: Uint8Array
  jti?: Uint8Array
  now?: number
}

const call = async (cfg: Config, s: Signer, method: string, shot: Shot): Promise<Answer> => {
  const body = bodyOf(s, method)
  const now = shot.now ?? Math.floor(Date.now() / 1000) + (shot.skew ?? 0)
  const signer = shot.forge ? { ...s, key: shot.forge } : s
  const jti = shot.jti ?? randomBytes(16)
  const { authorization } = signCall(signer, cfg.aud, method, body, now, jti, shot.stamp)
  const t0 = performance.now()
  try {
    const res = await fetch(`${cfg.base}/fed${method}`, {
      method: 'POST',
      headers: {
        Authorization: authorization,
        'Content-Type': 'application/proto',
        'Connect-Protocol-Version': '1',
        'User-Agent': 'rchat-fed/1',
        'X-Forwarded-For': shot.network,
      },
      body,
    })
    const refusal = res.ok ? null : refusalOf(await res.text())
    if (res.ok) await res.arrayBuffer()
    const reason = refusal?.reason ?? RefusalReason.UNSPECIFIED
    const name = reason === RefusalReason.UNSPECIFIED ? '' : ` ${RefusalReason[reason] ?? reason}`
    return {
      label: `${res.status}${name}`,
      ms: performance.now() - t0,
      retryAfter: Number(res.headers.get('retry-after') ?? 0) || 0,
      refusal: reason,
      work: Number(refusal?.stampWork ?? 0n),
    }
  } catch {
    return { label: 'error', ms: performance.now() - t0, retryAfter: 0, refusal: 0, work: 0 }
  }
}

export async function run(cfg: Config, given?: KeyServer): Promise<Report> {
  const refused = refusal(cfg)
  if (refused) throw new Error(refused)
  const keys = given ?? keyServer(cfg.keysPort, cfg.keysHost)
  const kinds = Object.fromEntries(
    KINDS.map(kind => [kind, { ms: [], by: new Map() }])
  ) as unknown as Record<Kind, Tally>
  let stamps = 0
  const count = (kind: Kind, label: string) =>
    kinds[kind].by.set(label, (kinds[kind].by.get(label) ?? 0) + 1)
  const record = (kind: Kind, answer: Answer) => {
    kinds[kind].ms.push(answer.ms)
    count(kind, answer.label)
    return answer
  }
  const host = (name: string) => {
    const signer = signerOf(`${name}.${cfg.suffix}`)
    keys.add(signer)
    return signer
  }
  const stamped = (s: Signer, work: number) => {
    const jti = randomBytes(16)
    const now = Math.floor(Date.now() / 1000)
    stamps += 1
    const stamp = stampFor(cfg.aud, s.origin, jti, BigInt(now), work, cfg.stampPuzzles)
    return { jti, now, stamp }
  }
  const hello = async (kind: Kind, s: Signer, network: string) => {
    const first = record(kind, await call(cfg, s, HELLO, { network }))
    if (first.refusal !== RefusalReason.STAMP_NEEDED) return first
    const work = first.work || cfg.stampWork
    return record(kind, await call(cfg, s, HELLO, { network, ...stamped(s, work) }))
  }

  const honest = Array.from({ length: cfg.hosts }, (_, i) => ({
    signer: host(`h${i}`),
    network: `10.1.${i % 250}.1`,
  }))
  const pressed = { signer: host('pressed'), network: '10.9.9.1' }
  const neighbour = { signer: host('neighbour'), network: '10.9.9.2' }
  const wrong = signerOf(`forger.${cfg.suffix}`).key
  for (const h of honest) await hello('honest', h.signer, h.network)
  await hello('pressed', pressed.signer, pressed.network)
  if (cfg.neighbour > 0) await hello('neighbour', neighbour.signer, neighbour.network)

  const holds = new Map<string, number>()
  const paced = async (kind: Kind, from: { signer: Signer; network: string }, method: string) => {
    const keysOf = [from.signer.host, `${from.signer.host} ${method}`]
    if (keysOf.some(key => (holds.get(key) ?? 0) > Date.now())) return count(kind, 'held')
    const answer = record(kind, await call(cfg, from.signer, method, { network: from.network }))
    const until = Date.now() + Math.max(1, answer.retryAfter) * 1000
    if (answer.refusal === RefusalReason.BUSY) holds.set(keysOf[0], until)
    else if (answer.label === '429') holds.set(keysOf[1], until)
  }

  const total = Math.round(cfg.rate * cfg.seconds)
  const mintedTotal = Math.round((cfg.minted * cfg.seconds) / 60)
  const neighbourTotal = Math.round(cfg.neighbour * cfg.seconds)
  const pending: Promise<unknown>[] = []
  const started = performance.now()
  let minted = 0
  let crowded = 0
  for (let n = 0; n < total; n += 1) {
    const wait = started + (n * 1000) / cfg.rate - performance.now()
    if (wait > 0) await Bun.sleep(wait)
    const from = honest[n % honest.length]
    const slot = n % 10
    pending.push(paced('honest', from, slot === 0 ? HELLO : slot < 7 ? DELIVER : PREVIEW))
    if (slot === 3)
      pending.push(
        call(cfg, from.signer, DELIVER, { network: from.network, forge: wrong }).then(a =>
          record('forged', a)
        )
      )
    if (slot === 8)
      pending.push(
        call(cfg, from.signer, DELIVER, { network: from.network, skew: -120 }).then(a =>
          record('stale', a)
        )
      )
    if (n % honest.length === 0) pending.push(paced('pressed', pressed, PREVIEW))
    for (; minted < Math.floor(((n + 1) * mintedTotal) / total); minted += 1) {
      const network = `10.200.${minted % cfg.networks}.${1 + (minted % 250)}`
      pending.push(
        call(cfg, host(`m${minted}.mint`), HELLO, { network }).then(a => record('minted', a))
      )
    }
    for (; crowded < Math.floor(((n + 1) * neighbourTotal) / total); crowded += 1)
      pending.push(
        call(cfg, neighbour.signer, PREVIEW, { network: neighbour.network }).then(a =>
          record('neighbour', a)
        )
      )
  }
  await Promise.all(pending)

  for (let i = 0; i < Math.round((cfg.stamped * cfg.seconds) / 60); i += 1) {
    const signer = host(`s${i}.mint`)
    const network = `10.201.${i % cfg.networks}.${1 + (i % 250)}`
    record('minted', await call(cfg, signer, HELLO, { network, ...stamped(signer, cfg.stampWork) }))
  }
  await hello('newcomer', host('new'), '10.8.8.1')

  const lines = KINDS.map(kind => {
    const by = [...kinds[kind].by].map(([label, n]) => `${label.replaceAll(' ', '_')}=${n}`)
    return stats(`fed ${kind}`, kinds[kind].ms, by.join(' '))
  })
  return { kinds, stamps, lines }
}

const ALLOWED: Record<Kind, string[] | null> = {
  honest: ['200', '429', '503 BUSY', 'held'],
  pressed: ['200', '429', '503 BUSY', 'held'],
  forged: ['401'],
  stale: ['401'],
  minted: ['200', '429', '503', '503 BUSY', '503 STAMP_NEEDED'],
  neighbour: null,
  newcomer: ['200', '503', '503 STAMP_NEEDED'],
}

export const verdict = ({ kinds }: Report) => {
  const failures = KINDS.flatMap(kind =>
    [...kinds[kind].by.keys()]
      .filter(label => ALLOWED[kind] !== null && !ALLOWED[kind].includes(label))
      .map(label => `${kind}: ${label}`)
  )
  const newcomer = kinds.newcomer.by
  if (!newcomer.has('200')) failures.push('newcomer: never accepted')
  if ((newcomer.get('503 STAMP_NEEDED') ?? 0) > 1)
    failures.push('newcomer: asked for a second stamp')
  return failures
}

const number = (value: string | undefined, fallback: number) => Number(value ?? fallback)

if (import.meta.main) {
  const base = need('BASE').replace(/\/+$/, '')
  const cfg: Config = {
    base,
    aud: process.env.FED_AUD ?? base,
    suffix: process.env.FED_SUFFIX ?? 'load.test',
    allowRemote: process.env.FED_ALLOW_REMOTE === '1',
    keysHost: process.env.FED_KEYS_HOST ?? '127.0.0.1',
    keysPort: Number(need('FED_KEYS_PORT')),
    hosts: number(process.env.FED_HOSTS, 10),
    rate: number(process.env.FED_RATE, 500),
    seconds: number(process.env.FED_SECONDS, 60),
    minted: number(process.env.FED_MINTED, 600),
    networks: number(process.env.FED_NETWORKS, 120),
    stamped: number(process.env.FED_STAMPED, 10),
    neighbour: number(process.env.FED_NEIGHBOUR, 50),
    stampWork: number(process.env.FED_STAMP_WORK, 2_000_000),
    stampPuzzles: 16,
  }
  const refused = refusal(cfg)
  if (refused) {
    console.error(refused)
    process.exit(2)
  }
  header('fed')
  const report = await run(cfg)
  for (const line of report.lines) log(line)
  const failures = verdict(report)
  for (const failure of failures) log(`FAILED ${failure}`)
  log(`fed: ${report.stamps} stamps solved, ${failures.length} failures`)
  finish(failures.length ? 1 : 0)
}

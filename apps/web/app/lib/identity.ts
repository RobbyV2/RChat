import {
  createLocalJWKSet,
  createRemoteJWKSet,
  decodeJwt,
  decodeProtectedHeader,
  errors,
  jwtVerify,
  type JSONWebKeySet,
  type JWTVerifyGetKey,
} from 'jose'
import { normalizeHost, privateHost } from './qualified'
import { time } from './platform/time'

export const ASSERTION_MAX_TTL = 300
// P2P identity bindings (the account badge): who `sub` is, vouched for by the instance, for the
// identity key `ik`, at most 7 days.
export const BINDING_AUD = 'rchat-p2p-bind'
export const BINDING_MAX_TTL = 7 * 24 * 60 * 60
const JWKS_PATH = '/.well-known/jwks.json'
const KEYS_TTL_MS = 10 * 60 * 1000
const BINDING_KEYS_TTL_MS = 5 * 60 * 1000
const REFETCH_MS = 30 * 1000
const LEEWAY = 30
const SETS_MAX = 100
const JTI_MAX = 128

export interface AssertionClaims {
  iss: string
  sub: string
  aud: string
  iat: number
  exp: number
  jti: string
  nonce?: string
}

export interface BindingClaims {
  iss: string
  sub: string
  aud: string
  ik: string
  iat: number
  exp: number
}

export type AssertionFailure =
  | 'ik'
  | 'malformed'
  | 'algorithm'
  | 'issuer'
  | 'unknown_key'
  | 'signature'
  | 'expired'
  | 'audience'
  | 'nonce'
  | 'subject'
  | 'lifetime'
  | 'fetch'

export class AssertionError extends Error {
  constructor(public code: AssertionFailure) {
    super(`Identity assertion rejected: ${code}`)
    this.name = 'AssertionError'
  }
}

// An issuer the rules accepted: https on a public host and any port but 0 (local hosts, and
// http on them, only with `allowLocal`). Only `Issuer.accept` makes one, and fetching and
// trusting keys take one. Its origin is the instance: another port is another issuer.
export class Issuer {
  readonly #iss: string
  readonly #origin: string
  readonly #host: string
  readonly #keys: string

  private constructor(iss: string, url: URL) {
    this.#iss = iss
    this.#origin = url.origin
    this.#host = url.host
    this.#keys = new URL(JWKS_PATH, url.origin).href
  }

  // As it was named.
  get iss() {
    return this.#iss
  }

  // One spelling (`https://chat.example.com:8443`, no default port): the verified claims' `iss`.
  get origin() {
    return this.#origin
  }

  // What its qualified names carry: `host`, or `host:port` off the default port.
  get host() {
    return this.#host
  }

  get keys() {
    return this.#keys
  }

  static accept(iss: string, allowLocal = false): Issuer {
    let url: URL
    try {
      url = new URL(iss)
    } catch {
      throw new AssertionError('issuer')
    }
    const local = privateHost(url.hostname)
    const scheme = url.protocol === 'https:' || (url.protocol === 'http:' && allowLocal && local)
    const port = url.port !== '0'
    const bare =
      (url.pathname === '/' || url.pathname === '') &&
      !url.search &&
      !url.hash &&
      !url.username &&
      !url.password &&
      !/[?#]/.test(iss)
    if (!scheme || !port || !bare || (local && !allowLocal)) throw new AssertionError('issuer')
    return new Issuer(iss, url)
  }
}

export const jwksUrl = (iss: string, allowLocal = false): URL =>
  new URL(Issuer.accept(iss, allowLocal).keys)

const sets = new Map<string, JWTVerifyGetKey>()

// The issuer's key set, cached for `cacheMaxAge` (one cache per lifetime, so assertions and
// bindings keep their own). Anything but a missing key means the issuer couldn't be asked
// (unreachable, an error status, a broken key set): `fetch`, never a verdict on the token.
function issuerKeys(issuer: Issuer, cacheMaxAge: number): JWTVerifyGetKey {
  const url = issuer.keys
  const id = `${cacheMaxAge} ${url}`
  const hit = sets.get(id)
  if (hit) return hit
  const remote = createRemoteJWKSet(new URL(url), { cacheMaxAge, cooldownDuration: REFETCH_MS })
  const keys: JWTVerifyGetKey = async (header, token) => {
    try {
      return await remote(header, token)
    } catch (e) {
      if (e instanceof errors.JWKSNoMatchingKey || e instanceof errors.JWKSMultipleMatchingKeys)
        throw e
      throw new AssertionError('fetch')
    }
  }
  if (sets.size >= SETS_MAX) {
    const oldest = sets.keys().next().value
    if (oldest !== undefined) sets.delete(oldest)
  }
  sets.set(id, keys)
  return keys
}

export const forgetIssuerKeys = () => sets.clear()

export interface VerifyOptions {
  aud: string
  nonce?: string
  keys?: JSONWebKeySet | JWTVerifyGetKey
  now?: Date
  allowLocal?: boolean
}

const failure = (e: unknown): AssertionFailure => {
  if (e instanceof AssertionError) return e.code
  if (e instanceof errors.JWTExpired) return 'expired'
  if (e instanceof errors.JWTClaimValidationFailed)
    return e.claim === 'aud' ? 'audience' : e.claim === 'iss' ? 'issuer' : 'malformed'
  if (e instanceof errors.JOSEAlgNotAllowed) return 'algorithm'
  if (e instanceof errors.JWKSNoMatchingKey) return 'unknown_key'
  if (e instanceof errors.JWSSignatureVerificationFailed) return 'signature'
  if (e instanceof errors.JWKSTimeout || e instanceof errors.JWKSInvalid) return 'fetch'
  if (e instanceof errors.JOSEError) return 'malformed'
  return 'fetch'
}

// The unverified issuer of a compact EdDSA JWT with a strict header.
const issuerOf = (token: string) => {
  let iss: unknown
  try {
    const parts = token.split('.')
    if (parts.length !== 3 || parts.some(p => !p)) throw new AssertionError('malformed')
    iss = decodeJwt(token).iss
    const header = decodeProtectedHeader(token)
    if (header.alg !== 'EdDSA') throw new AssertionError('algorithm')
    if (typeof header.kid !== 'string' || !header.kid) throw new AssertionError('unknown_key')
    if (header.typ !== 'JWT' || header.crit !== undefined) throw new AssertionError('malformed')
  } catch (e) {
    throw new AssertionError(e instanceof AssertionError ? e.code : 'malformed')
  }
  if (typeof iss !== 'string') throw new AssertionError('malformed')
  return iss
}

const keysFor = (issuer: Issuer, keys: VerifyOptions['keys'], cacheMaxAge: number) =>
  keys === undefined
    ? issuerKeys(issuer, cacheMaxAge)
    : typeof keys === 'function'
      ? keys
      : createLocalJWKSet(keys)

const asciiLower = (text: string) => text.replace(/[A-Z]/g, c => c.toLowerCase())

// `name@host` with exactly one `@`, on the issuer's host (ASCII case aside, as the server checks).
const onIssuerHost = (sub: unknown, issuer: Issuer) => {
  if (typeof sub !== 'string') return false
  const [name, host, ...more] = sub.split('@')
  return !!name && host !== undefined && more.length === 0 && asciiLower(host) === issuer.host
}

export async function verifyAssertion(
  token: string,
  { aud, nonce, keys, now, allowLocal = false }: VerifyOptions
): Promise<AssertionClaims> {
  const issuer = Issuer.accept(issuerOf(token), allowLocal || keys !== undefined)
  const getKey = keysFor(issuer, keys, KEYS_TTL_MS)
  let claims: AssertionClaims
  try {
    const { payload } = await jwtVerify(token, getKey, {
      issuer: issuer.iss,
      audience: aud,
      algorithms: ['EdDSA'],
      requiredClaims: ['exp', 'iat', 'sub', 'jti'],
      clockTolerance: LEEWAY,
      currentDate: now,
    })
    claims = payload as unknown as AssertionClaims
  } catch (e) {
    throw new AssertionError(failure(e))
  }
  if (
    typeof claims.jti !== 'string' ||
    !claims.jti ||
    new TextEncoder().encode(claims.jti).length > JTI_MAX
  )
    throw new AssertionError('malformed')
  const at = Math.floor((now ?? new Date(time().now())).getTime() / 1000)
  if (claims.iat > at + LEEWAY || claims.exp - claims.iat > ASSERTION_MAX_TTL)
    throw new AssertionError('lifetime')
  if (nonce !== undefined && claims.nonce !== nonce) throw new AssertionError('nonce')
  if (!onIssuerHost(claims.sub, issuer)) throw new AssertionError('subject')
  return { ...claims, iss: issuer.origin }
}

export interface BindingOptions {
  // The identity key the binding must be for (the contact's or member's).
  ik: string
  // The only issuer host accepted (this client's instance); none: any that passes the rules.
  host?: string
  keys?: JSONWebKeySet | JWTVerifyGetKey
  now?: Date
  allowLocal?: boolean
}

// A P2P identity binding (POST /api/identity/p2p_binding): the same issuer rules and key
// handling as assertions, its own audience, a lifetime of at most 7 days, keys cached 5 minutes.
// `expired` means a binding that verified but is past its `exp`.
export async function verifyBinding(
  token: string,
  { ik, host, keys, now, allowLocal = false }: BindingOptions
): Promise<BindingClaims> {
  const issuer = Issuer.accept(issuerOf(token), allowLocal || keys !== undefined)
  if (host !== undefined && normalizeHost(issuer.host) !== normalizeHost(host))
    throw new AssertionError('issuer')
  const getKey = keysFor(issuer, keys, BINDING_KEYS_TTL_MS)
  let claims: BindingClaims
  try {
    const { payload } = await jwtVerify(token, getKey, {
      issuer: issuer.iss,
      audience: BINDING_AUD,
      algorithms: ['EdDSA'],
      requiredClaims: ['exp', 'iat', 'sub', 'ik'],
      clockTolerance: LEEWAY,
      currentDate: now,
    })
    claims = payload as unknown as BindingClaims
  } catch (e) {
    throw new AssertionError(failure(e))
  }
  const at = Math.floor((now ?? new Date(time().now())).getTime() / 1000)
  if (claims.iat > at + LEEWAY || claims.exp - claims.iat > BINDING_MAX_TTL)
    throw new AssertionError('lifetime')
  if (claims.aud !== BINDING_AUD) throw new AssertionError('audience')
  if (claims.ik !== ik) throw new AssertionError('ik')
  if (!onIssuerHost(claims.sub, issuer)) throw new AssertionError('subject')
  return { ...claims, iss: issuer.origin }
}

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
import { hostOf, parseQualified, privateHost } from './qualified'

export const ASSERTION_MAX_TTL = 300
export const JWKS_PATH = '/.well-known/jwks.json'
const KEYS_TTL_MS = 10 * 60 * 1000
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

export type AssertionFailure =
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

export function jwksUrl(iss: string, allowLocal = false): URL {
  let url: URL
  try {
    url = new URL(iss)
  } catch {
    throw new AssertionError('issuer')
  }
  const local = privateHost(url.hostname)
  const scheme = url.protocol === 'https:' || (url.protocol === 'http:' && allowLocal && local)
  const port = local || url.port === ''
  const bare =
    (url.pathname === '/' || url.pathname === '') &&
    !url.search &&
    !url.hash &&
    !url.username &&
    !url.password &&
    !/[?#]/.test(iss)
  if (!scheme || !port || !bare || (local && !allowLocal)) throw new AssertionError('issuer')
  return new URL(JWKS_PATH, url.origin)
}

const sets = new Map<string, JWTVerifyGetKey>()

export function issuerKeys(
  iss: string,
  cacheMaxAge = KEYS_TTL_MS,
  allowLocal = false
): JWTVerifyGetKey {
  const url = jwksUrl(iss, allowLocal).href
  const hit = sets.get(url)
  if (hit) return hit
  const keys = createRemoteJWKSet(new URL(url), { cacheMaxAge, cooldownDuration: REFETCH_MS })
  if (sets.size >= SETS_MAX) {
    const oldest = sets.keys().next().value
    if (oldest !== undefined) sets.delete(oldest)
  }
  sets.set(url, keys)
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

export async function verifyAssertion(
  token: string,
  { aud, nonce, keys, now, allowLocal = false }: VerifyOptions
): Promise<AssertionClaims> {
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
  jwksUrl(iss, allowLocal || keys !== undefined)
  const getKey =
    keys === undefined
      ? issuerKeys(iss, KEYS_TTL_MS, allowLocal)
      : typeof keys === 'function'
        ? keys
        : createLocalJWKSet(keys)
  let claims: AssertionClaims
  try {
    const { payload } = await jwtVerify(token, getKey, {
      issuer: iss,
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
  const at = Math.floor((now ?? new Date()).getTime() / 1000)
  if (claims.iat > at + LEEWAY || claims.exp - claims.iat > ASSERTION_MAX_TTL)
    throw new AssertionError('lifetime')
  if (nonce !== undefined && claims.nonce !== nonce) throw new AssertionError('nonce')
  const subject = parseQualified(claims.sub)
  if (
    typeof claims.sub !== 'string' ||
    claims.sub.split('@').length !== 2 ||
    subject.host === null ||
    subject.host !== hostOf(iss)
  )
    throw new AssertionError('subject')
  return claims
}

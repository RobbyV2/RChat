// What a relying party must check, as plain functions: PKCE, the callback's state and issuer,
// signatures against the provider's keys, and the claims of ID tokens and logout tokens.
import { createHash, randomBytes } from 'node:crypto'

export type Jwk = {
  kty: string
  kid?: string
  alg?: string
  use?: string
  n?: string
  e?: string
  crv?: string
  x?: string
  y?: string
}
export type Jwks = { keys: Jwk[] }
export type Claims = Record<string, unknown>

export class RigError extends Error {
  constructor(
    public code: string,
    message = code
  ) {
    super(message)
  }
}

export const BACKCHANNEL_EVENT = 'http://schemas.openid.net/event/backchannel-logout'
export const ALGS = ['RS256', 'ES256'] as const
export const SKEW_SECS = 60

const b64url = (bytes: Uint8Array | Buffer) => Buffer.from(bytes).toString('base64url')
const strict = (part: string) => {
  if (!/^[A-Za-z0-9_-]*$/.test(part)) throw new RigError('invalid_token', 'not base64url')
  return Buffer.from(part, 'base64url')
}

export const randomToken = (bytes = 32) => b64url(randomBytes(bytes))

export const challengeOf = (verifier: string) =>
  b64url(createHash('sha256').update(verifier, 'ascii').digest())

export const pkcePair = () => {
  const verifier = randomToken(32)
  return { verifier, challenge: challengeOf(verifier) }
}

export type AuthorizeOptions = {
  scopes: string[]
  state: string
  nonce: string
  challenge: string
  prompt?: string
  maxAge?: number
  acrValues?: string
  joinServers?: string[]
  loginHint?: string
}

export const authorizeUrl = (
  endpoint: string,
  clientId: string,
  redirectUri: string,
  o: AuthorizeOptions
) => {
  const q = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: redirectUri,
    scope: [...new Set(['openid', ...o.scopes])].join(' '),
    state: o.state,
    nonce: o.nonce,
    code_challenge: o.challenge,
    code_challenge_method: 'S256',
  })
  if (o.prompt) q.set('prompt', o.prompt)
  if (o.maxAge !== undefined) q.set('max_age', String(o.maxAge))
  if (o.acrValues) q.set('acr_values', o.acrValues)
  if (o.joinServers?.length) q.set('join_servers', o.joinServers.join(','))
  if (o.loginHint) q.set('login_hint', o.loginHint)
  return `${endpoint}?${q.toString()}`
}

// RFC 9207: the response must name the issuer the request went to. An error from the provider
// is reported as it came; anything else that does not fit is refused before the code is used.
export const parseCallback = (url: string, expected: { state: string; issuer: string }) => {
  const q = new URL(url).searchParams
  if (q.get('state') !== expected.state) throw new RigError('state_mismatch')
  if (q.get('iss') !== expected.issuer) throw new RigError('issuer_mismatch')
  const error = q.get('error')
  if (error) throw new RigError(error, q.get('error_description') ?? error)
  const code = q.get('code')
  if (!code) throw new RigError('no_code')
  return { code }
}

const importKey = (jwk: Jwk, alg: (typeof ALGS)[number]) =>
  alg === 'RS256'
    ? crypto.subtle.importKey(
        'jwk',
        { kty: 'RSA', n: jwk.n, e: jwk.e, alg, ext: true },
        { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
        false,
        ['verify']
      )
    : crypto.subtle.importKey(
        'jwk',
        { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y, ext: true },
        { name: 'ECDSA', namedCurve: 'P-256' },
        false,
        ['verify']
      )

export type Verified = { header: Record<string, unknown>; claims: Claims }

export const verifyJws = async (token: string, jwks: Jwks): Promise<Verified> => {
  const parts = token.split('.')
  if (parts.length !== 3) throw new RigError('invalid_token', 'not a compact JWS')
  let header: Record<string, unknown>
  let claims: Claims
  try {
    header = JSON.parse(strict(parts[0]).toString('utf8'))
    claims = JSON.parse(strict(parts[1]).toString('utf8'))
  } catch {
    throw new RigError('invalid_token', 'not JSON')
  }
  const alg = ALGS.find(a => a === header.alg)
  if (!alg) throw new RigError('invalid_token', 'algorithm not allowed')
  const matching = jwks.keys.filter(k => k.kid !== undefined && k.kid === header.kid)
  if (matching.length !== 1) throw new RigError('invalid_token', 'unknown key')
  const jwk = matching[0]
  const fits =
    (alg === 'RS256' ? jwk.kty === 'RSA' : jwk.kty === 'EC' && jwk.crv === 'P-256') &&
    (jwk.alg === undefined || jwk.alg === alg) &&
    (jwk.use === undefined || jwk.use === 'sig')
  if (!fits) throw new RigError('invalid_token', 'key does not fit the algorithm')
  const key = await importKey(jwk, alg).catch(() => {
    throw new RigError('invalid_token', 'unusable key')
  })
  const ok = await crypto.subtle.verify(
    alg === 'RS256' ? 'RSASSA-PKCS1-v1_5' : { name: 'ECDSA', hash: 'SHA-256' },
    key,
    strict(parts[2]),
    Buffer.from(`${parts[0]}.${parts[1]}`)
  )
  if (!ok) throw new RigError('invalid_token', 'bad signature')
  return { header, claims }
}

export const atHash = (accessToken: string) => {
  const digest = createHash('sha256').update(accessToken, 'ascii').digest()
  return b64url(digest.subarray(0, digest.length / 2))
}

const need = (ok: boolean, what: string) => {
  if (!ok) throw new RigError('invalid_token', what)
}

export type IdTokenExpectations = {
  issuer: string
  clientId: string
  nonce: string | null
  now: number
  accessToken?: string
  maxAge?: number
}

export const checkIdToken = ({ header, claims }: Verified, x: IdTokenExpectations) => {
  need(header.typ === undefined || header.typ === 'JWT', 'typ')
  need(claims.iss === x.issuer, 'iss')
  need(claims.aud === x.clientId, 'aud')
  need(claims.azp === undefined || claims.azp === x.clientId, 'azp')
  need(typeof claims.sub === 'string' && claims.sub.length > 0, 'sub')
  need(typeof claims.exp === 'number' && claims.exp > x.now - SKEW_SECS, 'exp')
  need(typeof claims.iat === 'number' && claims.iat <= x.now + SKEW_SECS, 'iat')
  need(x.nonce === null ? claims.nonce === undefined : claims.nonce === x.nonce, 'nonce')
  if (x.accessToken !== undefined) need(claims.at_hash === atHash(x.accessToken), 'at_hash')
  if (x.maxAge !== undefined)
    need(
      typeof claims.auth_time === 'number' && x.now - claims.auth_time <= x.maxAge + SKEW_SECS,
      'auth_time'
    )
  return claims
}

// Back-Channel Logout 1.0 section 2.6.
export const checkLogoutToken = (
  { header, claims }: Verified,
  x: { issuer: string; clientId: string; now: number }
) => {
  need(header.typ === 'logout+jwt', 'typ')
  need(claims.iss === x.issuer, 'iss')
  need(claims.aud === x.clientId, 'aud')
  need(typeof claims.iat === 'number' && claims.iat <= x.now + SKEW_SECS, 'iat')
  need(typeof claims.exp === 'number' && claims.exp > x.now - SKEW_SECS, 'exp')
  need(typeof claims.jti === 'string' && claims.jti.length > 0, 'jti')
  need(claims.nonce === undefined, 'nonce')
  const events = claims.events
  need(
    typeof events === 'object' && events !== null && Object.hasOwn(events, BACKCHANNEL_EVENT),
    'events'
  )
  const sub = typeof claims.sub === 'string' ? claims.sub : null
  const sid = typeof claims.sid === 'string' ? claims.sid : null
  need(sub !== null || sid !== null, 'sub or sid')
  return { sub, sid, jti: claims.jti as string }
}

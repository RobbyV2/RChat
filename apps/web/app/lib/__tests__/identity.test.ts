import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  SignJWT,
  calculateJwkThumbprint,
  exportJWK,
  generateKeyPair,
  importJWK,
  type CryptoKey,
  type JSONWebKeySet,
  type JWK,
} from 'jose'
import {
  ASSERTION_MAX_TTL,
  AssertionError,
  forgetIssuerKeys,
  jwksUrl,
  verifyAssertion,
} from '../identity'

const ISS = 'https://chat.example.com'
const AUD = 'https://other.example'

interface Key {
  jwk: JWK
  priv: CryptoKey
}

const newKey = async (): Promise<Key> => {
  const { publicKey, privateKey } = await generateKeyPair('EdDSA', { extractable: true })
  const jwk = await exportJWK(publicKey)
  jwk.kid = await calculateJwkThumbprint(jwk)
  jwk.alg = 'EdDSA'
  jwk.use = 'sig'
  return { jwk, priv: privateKey }
}

const sign = (
  key: Key,
  claims: Record<string, unknown> = {},
  opts: { ttl?: number; iat?: number; kid?: string } = {}
) => {
  const iat = opts.iat ?? Math.floor(Date.now() / 1000)
  return new SignJWT({ sub: `alice@chat.example.com`, jti: 'j1', ...claims })
    .setProtectedHeader({ alg: 'EdDSA', typ: 'JWT', kid: opts.kid ?? key.jwk.kid })
    .setIssuer(typeof claims.iss === 'string' ? claims.iss : ISS)
    .setAudience(AUD)
    .setIssuedAt(iat)
    .setExpirationTime(iat + (opts.ttl ?? 300))
    .sign(key.priv)
}

const code = async (p: Promise<unknown>) => {
  try {
    await p
    return 'ok'
  } catch (e) {
    return e instanceof AssertionError ? e.code : `unexpected ${String(e)}`
  }
}

describe('verifyAssertion against a local JWKS', () => {
  test('accepts a valid assertion and returns its claims', async () => {
    const key = await newKey()
    const keys: JSONWebKeySet = { keys: [key.jwk] }
    const token = await sign(key, { nonce: 'n1' })
    const claims = await verifyAssertion(token, { aud: AUD, nonce: 'n1', keys })
    expect(claims.sub).toBe('alice@chat.example.com')
    expect(claims.iss).toBe(ISS)
    expect(claims.nonce).toBe('n1')
    expect(claims.exp - claims.iat).toBe(ASSERTION_MAX_TTL)
  })

  test('rejects wrong audience, nonce, issuer host, lifetime, expiry and keys', async () => {
    const key = await newKey()
    const other = await newKey()
    const keys: JSONWebKeySet = { keys: [key.jwk] }
    const token = await sign(key, { nonce: 'n1' })
    expect(await code(verifyAssertion(token, { aud: 'https://x.example', keys }))).toBe('audience')
    expect(await code(verifyAssertion(token, { aud: AUD, nonce: 'n2', keys }))).toBe('nonce')
    expect(await code(verifyAssertion(token, { aud: AUD, keys: { keys: [other.jwk] } }))).toBe(
      'unknown_key'
    )
    const swapped = { ...other.jwk, kid: key.jwk.kid }
    expect(await code(verifyAssertion(token, { aud: AUD, keys: { keys: [swapped] } }))).toBe(
      'signature'
    )
    const foreign = await sign(key, { sub: 'alice@evil.example' })
    expect(await code(verifyAssertion(foreign, { aud: AUD, keys }))).toBe('subject')
    const bare = await sign(key, { sub: 'alice' })
    expect(await code(verifyAssertion(bare, { aud: AUD, keys }))).toBe('subject')
    const doubled = await sign(key, { sub: 'a@b@chat.example.com' })
    expect(await code(verifyAssertion(doubled, { aud: AUD, keys }))).toBe('subject')
    const long = await sign(key, {}, { ttl: 3600 })
    expect(await code(verifyAssertion(long, { aud: AUD, keys }))).toBe('lifetime')
    const old = await sign(key, {}, { iat: Math.floor(Date.now() / 1000) - 1000 })
    expect(await code(verifyAssertion(old, { aud: AUD, keys }))).toBe('expired')
    for (const jti of ['', 'x'.repeat(129), 'é'.repeat(65), 7])
      expect(await code(verifyAssertion(await sign(key, { jti }), { aud: AUD, keys }))).toBe(
        'malformed'
      )
    expect(
      await code(verifyAssertion(await sign(key, { jti: 'x'.repeat(128) }), { aud: AUD, keys }))
    ).toBe('ok')
    const noKid = await sign(key, {}, { kid: '' })
    expect(await code(verifyAssertion(noKid, { aud: AUD, keys }))).toBe('unknown_key')
    const [, body, sig] = token.split('.')
    const header = (h: object) => Buffer.from(JSON.stringify(h)).toString('base64url')
    for (const h of [
      { alg: 'none', kid: key.jwk.kid, typ: 'JWT' },
      { alg: 'HS256', kid: key.jwk.kid, typ: 'JWT' },
      { alg: 'eddsa', kid: key.jwk.kid, typ: 'JWT' },
    ])
      expect(await code(verifyAssertion(`${header(h)}.${body}.${sig}`, { aud: AUD, keys }))).toBe(
        'algorithm'
      )
    for (const h of [
      { alg: 'EdDSA', kid: key.jwk.kid, typ: 'at+jwt' },
      { alg: 'EdDSA', kid: key.jwk.kid, typ: 'JWT', crit: ['exp'] },
    ])
      expect(await code(verifyAssertion(`${header(h)}.${body}.${sig}`, { aud: AUD, keys }))).toBe(
        'malformed'
      )
    expect(
      await code(verifyAssertion(`${header({ alg: 'none' })}.${body}.`, { aud: AUD, keys }))
    ).toBe('malformed')
    expect(await code(verifyAssertion('not.a.jwt', { aud: AUD, keys }))).toBe('malformed')
    const [h, , s] = token.split('.')
    const forged = Buffer.from(
      JSON.stringify({ iss: ISS, sub: 'root@chat.example.com', aud: AUD, iat: 1, exp: 9e9 })
    ).toString('base64url')
    expect(await code(verifyAssertion(`${h}.${forged}.${s}`, { aud: AUD, keys }))).toBe('signature')
  })

  test('jwksUrl follows the same rules as the Rust verifier', () => {
    expect(jwksUrl('https://chat.example.com').href).toBe(
      'https://chat.example.com/.well-known/jwks.json'
    )
    expect(jwksUrl('http://127.0.0.1:3821/', true).href).toBe(
      'http://127.0.0.1:3821/.well-known/jwks.json'
    )
    expect(jwksUrl('https://chat.example.com:443').href).toBe(
      'https://chat.example.com/.well-known/jwks.json'
    )
    for (const bad of [
      'https://chat.example.com:8443',
      'https://chat.example.com:80',
      'http://127.0.0.1:3821',
      'https://127.0.0.1:3821',
      'https://localhost',
      'https://10.0.0.5:8443',
      'https://192.168.1.2',
      'https://169.254.169.254',
      'https://[::1]',
      'https://[fd00::1]',
      'https://nas.local',
      'http://chat.example.com',
      'https://chat.example.com/sub',
      'https://chat.example.com/?x',
      'https://u:p@chat.example.com',
      'nope',
    ]) {
      let failed = ''
      try {
        jwksUrl(bad)
      } catch (e) {
        failed = e instanceof AssertionError ? e.code : 'other'
      }
      expect(failed).toBe('issuer')
    }
  })
})

describe('verifyAssertion against the issuer JWKS', () => {
  const real = globalThis.fetch
  let served: JSONWebKeySet = { keys: [] }
  let fetched: string[] = []

  beforeEach(() => {
    forgetIssuerKeys()
    fetched = []
    globalThis.fetch = (async (input: string | URL | Request) => {
      fetched.push(String(input instanceof Request ? input.url : input))
      return new Response(JSON.stringify(served), {
        headers: { 'Content-Type': 'application/json' },
      })
    }) as typeof fetch
  })

  afterEach(() => {
    globalThis.fetch = real
  })

  test('fetches https://{host}/.well-known/jwks.json once and caches it', async () => {
    const key = await newKey()
    served = { keys: [key.jwk] }
    await verifyAssertion(await sign(key), { aud: AUD })
    await verifyAssertion(await sign(key), { aud: AUD })
    expect(fetched).toEqual(['https://chat.example.com/.well-known/jwks.json'])
    const rotated = await newKey()
    expect(await code(verifyAssertion(await sign(rotated), { aud: AUD }))).toBe('unknown_key')
  })

  test('never fetches keys from a private or plain-http issuer', async () => {
    const key = await newKey()
    served = { keys: [key.jwk] }
    for (const iss of ['http://127.0.0.1:3821', 'https://10.0.0.5', 'https://[::1]:3000']) {
      const sub = `alice@${new URL(iss).host}`
      expect(await code(verifyAssertion(await sign(key, { iss, sub }), { aud: AUD }))).toBe(
        'issuer'
      )
    }
    expect(fetched).toEqual([])
    const local = await sign(key, { iss: 'http://127.0.0.1:3821', sub: 'alice@127.0.0.1:3821' })
    expect((await verifyAssertion(local, { aud: AUD, allowLocal: true })).sub).toBe(
      'alice@127.0.0.1:3821'
    )
    expect(fetched).toEqual(['http://127.0.0.1:3821/.well-known/jwks.json'])
  })
})

describe('Rust-issued assertion', () => {
  test('verifies with the TS helper at its issue time', async () => {
    const jwk: JWK = {
      kty: 'OKP',
      crv: 'Ed25519',
      x: '11qYAYKxCrfVS_7TyWQHOg7hcvPapiMlrwIaaPcHURo',
      kid: 'kPrK_qmxVWaYVA9wwBF6Iuo3vVzz7TxHCTwXBygrS4k',
      alg: 'EdDSA',
      use: 'sig',
    }
    expect(await calculateJwkThumbprint(jwk)).toBe(jwk.kid as string)
    await importJWK(jwk, 'EdDSA')
    const claims = await verifyAssertion(RUST_TOKEN, {
      aud: 'https://other.example',
      nonce: 'rust-nonce',
      keys: { keys: [jwk] },
      now: new Date(RUST_IAT * 1000),
    })
    expect(claims.sub).toBe('alice@127.0.0.1:3821')
    expect(claims.iss).toBe('http://127.0.0.1:3821')
  })
})

const RUST_IAT = 1793056306
const RUST_TOKEN =
  'eyJ0eXAiOiJKV1QiLCJhbGciOiJFZERTQSIsImtpZCI6ImtQcktfcW14VldhWVZBOXd3QkY2SXVvM3ZWeno3VHhIQ1R3WEJ5Z3JTNGsifQ.eyJpc3MiOiJodHRwOi8vMTI3LjAuMC4xOjM4MjEiLCJzdWIiOiJhbGljZUAxMjcuMC4wLjE6MzgyMSIsImF1ZCI6Imh0dHBzOi8vb3RoZXIuZXhhbXBsZSIsImlhdCI6MTc5MzA1NjMwNiwiZXhwIjoxNzkzMDU2NjA2LCJqdGkiOiIzZDI5ZmJiMDRiYjVjMjA2YzJmMzM3NDdiYzhiNTM4OCIsIm5vbmNlIjoicnVzdC1ub25jZSJ9.EWf0xvIIoBP4_CHZrISAiQ2dmfhla0he9sBC8BMzbikw6zB2PRUIdhCogzYHDlhXBpGgNIcQH_gbzQV9w2wFAw'

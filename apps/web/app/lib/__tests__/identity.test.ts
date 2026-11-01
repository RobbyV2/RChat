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
  BINDING_AUD,
  BINDING_MAX_TTL,
  forgetIssuerKeys,
  jwksUrl,
  verifyAssertion,
  verifyBinding,
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

const IK = 'AbjK1pmVnQ8bYf5NvO1z1Re2mUQu8jF5qX3VhH2s0nM'
const OTHER_IK = 'BmT3gqGqUyN2wJ1yQd2eK0a3mH8wYd7cS1pZ9xVq4Lk'

const bind = (
  key: Key,
  claims: Record<string, unknown> = {},
  opts: { ttl?: number; iat?: number; kid?: string; aud?: string | string[] } = {}
) => {
  const iat = opts.iat ?? Math.floor(Date.now() / 1000)
  return new SignJWT({ sub: 'alice@chat.example.com', ik: IK, ...claims })
    .setProtectedHeader({ alg: 'EdDSA', typ: 'JWT', kid: opts.kid ?? key.jwk.kid })
    .setIssuer(typeof claims.iss === 'string' ? claims.iss : ISS)
    .setAudience(opts.aud ?? BINDING_AUD)
    .setIssuedAt(iat)
    .setExpirationTime(iat + (opts.ttl ?? BINDING_MAX_TTL))
    .sign(key.priv)
}

describe('verifyBinding', () => {
  test('accepts a binding for the identity key and returns its claims', async () => {
    const key = await newKey()
    const keys: JSONWebKeySet = { keys: [key.jwk] }
    const claims = await verifyBinding(await bind(key), { ik: IK, keys })
    expect(claims.sub).toBe('alice@chat.example.com')
    expect(claims.ik).toBe(IK)
    expect(claims.aud).toBe(BINDING_AUD)
    expect(claims.exp - claims.iat).toBe(BINDING_MAX_TTL)
    expect(
      (await verifyBinding(await bind(key), { ik: IK, keys, host: 'chat.example.com' })).iss
    ).toBe(ISS)
  })

  test('rejects another identity key, audience, issuer key, expiry, issuer and subject', async () => {
    const key = await newKey()
    const other = await newKey()
    const keys: JSONWebKeySet = { keys: [key.jwk] }
    const token = await bind(key)
    expect(await code(verifyBinding(token, { ik: OTHER_IK, keys }))).toBe('ik')
    expect(await code(verifyBinding(await bind(key, { ik: 7 }), { ik: IK, keys }))).toBe('ik')
    expect(await code(verifyBinding(await bind(key, { ik: undefined }), { ik: IK, keys }))).toBe(
      'malformed'
    )
    // An identity assertion is no binding, and the reverse.
    expect(await code(verifyBinding(await bind(key, {}, { aud: AUD }), { ik: IK, keys }))).toBe(
      'audience'
    )
    expect(
      await code(verifyBinding(await bind(key, {}, { aud: [BINDING_AUD, AUD] }), { ik: IK, keys }))
    ).toBe('audience')
    expect(await code(verifyAssertion(token, { aud: BINDING_AUD, keys }))).toBe('malformed')
    // Signed by a key the issuer doesn't publish, or claiming one of its kids.
    expect(await code(verifyBinding(token, { ik: IK, keys: { keys: [other.jwk] } }))).toBe(
      'unknown_key'
    )
    const swapped = { ...other.jwk, kid: key.jwk.kid }
    expect(await code(verifyBinding(token, { ik: IK, keys: { keys: [swapped] } }))).toBe(
      'signature'
    )
    const forged = await bind(other, {}, { kid: key.jwk.kid })
    expect(await code(verifyBinding(forged, { ik: IK, keys }))).toBe('signature')
    const old = Math.floor(Date.now() / 1000) - BINDING_MAX_TTL - 100
    expect(await code(verifyBinding(await bind(key, {}, { iat: old }), { ik: IK, keys }))).toBe(
      'expired'
    )
    expect(
      await code(verifyBinding(token, { ik: IK, keys, now: new Date(Date.now() + 8 * 86_400_000) }))
    ).toBe('expired')
    expect(
      await code(
        verifyBinding(await bind(key, {}, { ttl: BINDING_MAX_TTL + 60 }), { ik: IK, keys })
      )
    ).toBe('lifetime')
    const later = Math.floor(Date.now() / 1000) + 3600
    expect(await code(verifyBinding(await bind(key, {}, { iat: later }), { ik: IK, keys }))).toBe(
      'lifetime'
    )
    // Only from the instance it is checked against, and only for an account there.
    expect(await code(verifyBinding(token, { ik: IK, keys, host: 'other.example' }))).toBe('issuer')
    for (const sub of ['alice@evil.example', 'alice', 'a@b@chat.example.com'])
      expect(await code(verifyBinding(await bind(key, { sub }), { ik: IK, keys }))).toBe('subject')
    expect(await code(verifyBinding('not.a.jwt', { ik: IK, keys }))).toBe('malformed')
  })
})

describe('verifyBinding against the issuer JWKS', () => {
  const real = globalThis.fetch
  let served: JSONWebKeySet = { keys: [] }
  let status = 200
  let fetched: string[] = []

  beforeEach(() => {
    forgetIssuerKeys()
    fetched = []
    status = 200
    globalThis.fetch = (async (input: string | URL | Request) => {
      fetched.push(String(input instanceof Request ? input.url : input))
      return new Response(JSON.stringify(served), {
        status,
        headers: { 'Content-Type': 'application/json' },
      })
    }) as typeof fetch
  })

  afterEach(() => {
    globalThis.fetch = real
  })

  test('uses the issuer keys, cached apart from assertions, and needs allowLocal for local ones', async () => {
    const key = await newKey()
    served = { keys: [key.jwk] }
    await verifyBinding(await bind(key), { ik: IK })
    await verifyBinding(await bind(key), { ik: IK })
    expect(fetched).toEqual(['https://chat.example.com/.well-known/jwks.json'])
    await verifyAssertion(await sign(key), { aud: AUD })
    expect(fetched.length).toBe(2)
    const local = await bind(key, { iss: 'http://127.0.0.1:3821', sub: 'alice@127.0.0.1:3821' })
    expect(await code(verifyBinding(local, { ik: IK }))).toBe('issuer')
    expect(fetched.length).toBe(2)
    expect((await verifyBinding(local, { ik: IK, allowLocal: true })).sub).toBe(
      'alice@127.0.0.1:3821'
    )
    expect(
      await code(verifyBinding(local, { ik: IK, allowLocal: true, host: 'chat.example.com' }))
    ).toBe('issuer')
  })

  test('an issuer that answers with an error, or not at all, is "fetch", never a verdict', async () => {
    const key = await newKey()
    served = { keys: [key.jwk] }
    status = 502
    expect(await code(verifyBinding(await bind(key), { ik: IK }))).toBe('fetch')
    forgetIssuerKeys()
    globalThis.fetch = (async () => {
      throw new TypeError('Failed to fetch')
    }) as unknown as typeof fetch
    expect(await code(verifyBinding(await bind(key), { ik: IK }))).toBe('fetch')
    expect(await code(verifyAssertion(await sign(key), { aud: AUD }))).toBe('fetch')
  })
})

describe('Rust-issued binding', () => {
  test('verifies with the TS helper at its issue time, for its identity key only', async () => {
    const jwk: JWK = {
      kty: 'OKP',
      crv: 'Ed25519',
      x: '11qYAYKxCrfVS_7TyWQHOg7hcvPapiMlrwIaaPcHURo',
      kid: 'kPrK_qmxVWaYVA9wwBF6Iuo3vVzz7TxHCTwXBygrS4k',
      alg: 'EdDSA',
      use: 'sig',
    }
    const at = new Date(RUST_BIND_IAT * 1000)
    const claims = await verifyBinding(RUST_BIND_TOKEN, {
      ik: RUST_BIND_IK,
      keys: { keys: [jwk] },
      now: at,
      host: '127.0.0.1:3821',
    })
    expect(claims).toEqual({
      iss: 'http://127.0.0.1:3821',
      sub: 'alice@127.0.0.1:3821',
      aud: BINDING_AUD,
      ik: RUST_BIND_IK,
      iat: RUST_BIND_IAT,
      exp: RUST_BIND_IAT + BINDING_MAX_TTL,
    })
    expect(
      await code(verifyBinding(RUST_BIND_TOKEN, { ik: IK, keys: { keys: [jwk] }, now: at }))
    ).toBe('ik')
    expect(
      await code(
        verifyBinding(RUST_BIND_TOKEN, {
          ik: RUST_BIND_IK,
          keys: { keys: [jwk] },
          now: new Date((RUST_BIND_IAT + BINDING_MAX_TTL + 60) * 1000),
        })
      )
    ).toBe('expired')
  })
})

// The fixed vectors of the Rust test `binding_proofs_and_tokens_match_the_fixed_vectors`.
const RUST_BIND_IAT = 1793056306
const RUST_BIND_IK = '6kpsY-KcUgq-9VB7Ey7F-ZVHdq6-vnuSQh7qaRRG0iw'
const RUST_BIND_TOKEN =
  'eyJhbGciOiJFZERTQSIsImtpZCI6ImtQcktfcW14VldhWVZBOXd3QkY2SXVvM3ZWeno3VHhIQ1R3WEJ5Z3JTNGsiLCJ0eXAiOiJKV1QifQ.eyJpc3MiOiJodHRwOi8vMTI3LjAuMC4xOjM4MjEiLCJzdWIiOiJhbGljZUAxMjcuMC4wLjE6MzgyMSIsImF1ZCI6InJjaGF0LXAycC1iaW5kIiwiaWsiOiI2a3BzWS1LY1VncS05VkI3RXk3Ri1aVkhkcTYtdm51U1FoN3FhUlJHMGl3IiwiaWF0IjoxNzkzMDU2MzA2LCJleHAiOjE3OTM2NjExMDZ9.fc47iS6ATl5Vb9s-ZMHAemFri8l87vnGKjCsw7yWG5kR5S892h3A9LFLEUczeCC1xQ6LqPJ8_qHxznRAHMi7AA'

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

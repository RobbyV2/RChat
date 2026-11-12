import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import {
  BACKCHANNEL_EVENT,
  JOINS_PER_DAY,
  redirectMatches,
  startProvider,
  type FakePerson,
} from './fake_provider'
import { RelyingParty, type Fetch, type Session } from './rp/client'
import {
  RigError,
  atHash,
  authorizeUrl,
  challengeOf,
  checkIdToken,
  checkLogoutToken,
  parseCallback,
  pkcePair,
  verifyJws,
} from './rp/oidc'
import { startRig } from './rp/server'
import { base32Decode, codeFor, hotp, secretOf, totp } from './totp'

const alice: FakePerson = { uid: 1, username: 'alice', name: 'Alice', roles: { lobby: ['Staff'] } }
const root: FakePerson = { uid: 2, username: 'root', name: 'Root', isSiteAdmin: true }

let clock = 1_800_000_000
const now = () => clock
const contacted = new Set<string>()
const local: Fetch = (input, init) => {
  contacted.add(new URL(input).hostname)
  return fetch(input, init)
}

let provider: Awaited<ReturnType<typeof startProvider>>
let rig: ReturnType<typeof startRig>
let rp: RelyingParty
let es: RelyingParty
let tv: RelyingParty

const code = async (url: string) => {
  const res = await fetch(url, { redirect: 'manual' })
  return { status: res.status, location: res.headers.get('location'), body: await res.text() }
}

const signIn = async (
  party: RelyingParty,
  ticked: string[] | undefined,
  scopes: string[],
  person = alice,
  servers?: string[]
): Promise<Session> => {
  provider.decide({ person, approve: true, ticked, servers })
  const { url } = await party.begin({ scopes })
  const { location } = await code(url)
  return party.complete(location ?? '')
}

beforeAll(async () => {
  const scopes = [
    'servers',
    'servers.join',
    'servers.read',
    'servers.members.read',
    'messages.read',
    'messages.send',
    'offline_access',
    'admin',
  ]
  provider = await startProvider({
    now,
    adminControl: true,
    servers: [
      { key: 'lobby', members: [1] },
      { key: 'team', members: [1] },
      { key: 'vault', password: 'open sesame', members: [] },
      { key: 'gate', banned: [1], members: [] },
      { key: 'shut', closed: true, members: [] },
    ],
    applications: [
      {
        id: 'application_rig',
        secret: 'rck_rig',
        redirects: ['http://127.0.0.1/cb'],
        scopes,
        grants: ['authorization_code', 'refresh_token'],
        alg: 'RS256',
        sessionRequired: true,
      },
      {
        id: 'application_es',
        redirects: ['http://127.0.0.1/cb'],
        scopes,
        grants: ['authorization_code'],
        alg: 'ES256',
        mayAskAdmin: true,
      },
      {
        id: 'application_tv',
        redirects: [],
        scopes: ['messages.read', 'admin'],
        grants: ['device_code'],
      },
      {
        id: 'application_paused',
        redirects: ['http://127.0.0.1/cb'],
        scopes: [],
        grants: ['authorization_code'],
        paused: true,
      },
    ],
  })
  rig = startRig({
    issuer: provider.issuer,
    clientId: 'application_rig',
    clientSecret: 'rck_rig',
    fetch: local,
    now,
  })
  rp = rig.rp
  const config = (clientId: string) => ({
    issuer: provider.issuer,
    clientId,
    redirectUri: `${rig.url}/cb`,
    fetch: local,
    now,
  })
  es = new RelyingParty(config('application_es'))
  tv = new RelyingParty(config('application_tv'))
})

afterAll(() => {
  rig.stop()
  provider.stop()
})

describe('the rig runs alone', () => {
  test('both sides bind a free port on this machine and nothing else is contacted', async () => {
    expect(rig.port).toBeGreaterThan(0)
    expect(provider.port).toBeGreaterThan(0)
    expect(rig.port).not.toBe(provider.port)
    expect(new URL(rig.url).hostname).toBe('127.0.0.1')
    expect(new URL(provider.issuer).hostname).toBe('127.0.0.1')
    await rp.discover()
    await signIn(rp, undefined, ['profile'])
    expect([...contacted]).toEqual(['127.0.0.1'])
  })
})

describe('discovery', () => {
  test('the issuer must be the one asked and must offer S256', async () => {
    const d = await rp.discover()
    expect(d.issuer).toBe(provider.issuer)
    expect(d.code_challenge_methods_supported).toEqual(['S256'])
    const elsewhere = new RelyingParty({
      issuer: `${provider.issuer}/`,
      clientId: 'x',
      redirectUri: `${rig.url}/cb`,
      fetch: local,
    })
    await expect(elsewhere.discover()).rejects.toBeInstanceOf(RigError)
    const lying: Fetch = async () =>
      new Response(
        JSON.stringify({
          issuer: 'https://other.example',
          code_challenge_methods_supported: ['S256'],
        })
      )
    const fooled = new RelyingParty({
      issuer: provider.issuer,
      clientId: 'x',
      redirectUri: 'x',
      fetch: lying,
    })
    await expect(fooled.discover()).rejects.toMatchObject({ code: 'issuer_mismatch' })
    const plain: Fetch = async () => new Response(JSON.stringify({ issuer: provider.issuer }))
    const weak = new RelyingParty({
      issuer: provider.issuer,
      clientId: 'x',
      redirectUri: 'x',
      fetch: plain,
    })
    await expect(weak.discover()).rejects.toMatchObject({ code: 'no_pkce' })
  })
})

describe('the code flow with PKCE', () => {
  test('RFC 7636 appendix B, and every request gets a fresh verifier, state and nonce', async () => {
    expect(challengeOf('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk')).toBe(
      'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM'
    )
    const a = pkcePair()
    expect(a.verifier).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(a.challenge).toBe(challengeOf(a.verifier))
    const one = new URL((await rp.begin({ scopes: ['servers'], joinServers: ['lobby'] })).url)
    const two = new URL((await rp.begin()).url)
    expect(one.searchParams.get('code_challenge_method')).toBe('S256')
    expect(one.searchParams.get('scope')).toBe('openid servers')
    expect(one.searchParams.get('join_servers')).toBe('lobby')
    expect(one.searchParams.get('redirect_uri')).toBe(`${rig.url}/cb`)
    for (const name of ['state', 'nonce', 'code_challenge'])
      expect(one.searchParams.get(name)).not.toBe(two.searchParams.get(name))
    expect(
      authorizeUrl('https://chat.example.com/oauth/authorize', 'c', 'https://a.example/cb', {
        scopes: ['openid', 'profile'],
        state: 's',
        nonce: 'n',
        challenge: 'c',
        prompt: 'none',
        maxAge: 0,
      })
    ).toBe(
      'https://chat.example.com/oauth/authorize?response_type=code&client_id=c&redirect_uri=https%3A%2F%2Fa.example%2Fcb&scope=openid+profile&state=s&nonce=n&code_challenge=c&code_challenge_method=S256&prompt=none&max_age=0'
    )
  })
  test('a sign-in ends with a checked ID token, RS256 and ES256', async () => {
    const s = await signIn(rp, undefined, ['profile', 'servers'])
    expect(s.scope).toEqual(['openid', 'profile', 'servers'])
    expect(s.claims).toMatchObject({
      iss: provider.issuer,
      aud: 'application_rig',
      azp: 'application_rig',
      preferred_username: 'alice',
      name: 'Alice',
      acr: 'urn:rchat:acr:1fa',
      amr: ['pwd'],
    })
    expect(s.claims.at_hash).toBe(atHash(s.accessToken))
    expect(s.sub).toHaveLength(43)
    expect(s.sid).toBe(String(s.claims.sid))
    expect(JSON.parse(Buffer.from(s.idToken.split('.')[0], 'base64url').toString()).alg).toBe(
      'RS256'
    )
    const e = await signIn(es, undefined, ['profile'])
    expect(JSON.parse(Buffer.from(e.idToken.split('.')[0], 'base64url').toString()).alg).toBe(
      'ES256'
    )
    expect(e.refreshToken).toBeNull()
    for (const forbidden of ['email', 'is_site_admin', 'site_admin', 'admin'])
      expect(Object.keys(s.claims)).not.toContain(forbidden)
  })
  test('the subject is pairwise: one person, two applications, two subjects', async () => {
    const a = await signIn(rp, undefined, ['profile'])
    const b = await signIn(es, undefined, ['profile'])
    const again = await signIn(rp, undefined, ['profile'])
    expect(a.sub).not.toBe(b.sub)
    expect(again.sub).toBe(a.sub)
  })
  test('a callback with another state or issuer, or a code used twice, signs nobody in', async () => {
    provider.decide({ person: alice, approve: true })
    const { url, state } = await rp.begin()
    const { location } = await code(url)
    const back = new URL(location ?? '')
    expect(back.searchParams.get('iss')).toBe(provider.issuer)
    expect(back.searchParams.get('state')).toBe(state)
    const other = new URL(back)
    other.searchParams.set('state', 'someone-elses')
    await expect(rp.complete(other.toString())).rejects.toMatchObject({ code: 'state_mismatch' })
    const mixed = new URL(back)
    mixed.searchParams.set('iss', 'https://other.example')
    await expect(rp.complete(mixed.toString())).rejects.toMatchObject({ code: 'issuer_mismatch' })
    await expect(rp.complete(back.toString())).rejects.toMatchObject({ code: 'state_mismatch' })
    expect(() =>
      parseCallback(`${rig.url}/cb?state=s&iss=${encodeURIComponent(provider.issuer)}`, {
        state: 's',
        issuer: provider.issuer,
      })
    ).toThrow('no_code')
  })
  test('a code is single use, and using it twice ends what it issued', async () => {
    provider.decide({ person: alice, approve: true })
    const { url } = await rp.begin()
    const { location } = await code(url)
    const s = await rp.complete(location ?? '')
    expect((await rp.api(s.id, 'GET', '/api/v1/oauth/servers')).status).toBe(403)
    const replay = await fetch(`${provider.issuer}/oauth/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code: new URL(location ?? '').searchParams.get('code') ?? '',
        redirect_uri: `${rig.url}/cb`,
        code_verifier: 'x'.repeat(43),
        client_id: 'application_rig',
        client_secret: 'rck_rig',
      }).toString(),
    })
    expect(replay.status).toBe(400)
    expect(await replay.json()).toMatchObject({ error: 'invalid_grant' })
    expect((await rp.api(s.id, 'GET', '/api/v1/oauth/servers')).status).toBe(401)
  })
  test('errors come back with state and issuer, and their text never echoes the request', async () => {
    provider.decide({ person: alice, approve: false })
    const denied = await rp.begin()
    await expect(rp.complete((await code(denied.url)).location ?? '')).rejects.toMatchObject({
      code: 'access_denied',
    })
    const { url } = await rp.begin({ scopes: ['zoë"x'] })
    const { location } = await code(url)
    const back = new URL(location ?? '')
    expect(back.searchParams.get('error')).toBe('invalid_scope')
    expect(back.searchParams.get('error_description')).toMatch(/^[\x20\x21\x23-\x5b\x5d-\x7e]+$/)
    expect(back.searchParams.get('error_description')).not.toContain('zo')
    await expect(rp.complete(location ?? '')).rejects.toMatchObject({ code: 'invalid_scope' })
    const silent = await rp.begin({ prompt: 'none' })
    await expect(rp.complete((await code(silent.url)).location ?? '')).rejects.toMatchObject({
      code: 'login_required',
    })
  })
  test("an unknown application or return address stays on the provider's own page", async () => {
    const stranger = await code(
      `${provider.issuer}/oauth/authorize?client_id=nobody&redirect_uri=${encodeURIComponent(`${rig.url}/cb`)}`
    )
    expect(stranger.status).toBe(400)
    expect(stranger.location).toBeNull()
    const { url } = await rp.begin()
    const moved = new URL(url)
    moved.searchParams.set('redirect_uri', 'https://evil.example/cb')
    const refused = await code(moved.toString())
    expect(refused.status).toBe(400)
    expect(refused.location).toBeNull()
    expect(redirectMatches(['http://127.0.0.1/cb'], 'http://127.0.0.1:5000/cb')).toBe(true)
    expect(redirectMatches(['https://a.example/cb'], 'https://a.example/cb/')).toBe(false)
    expect(redirectMatches(['https://a.example/cb'], 'https://A.example/cb')).toBe(false)
    const plain = new URL(url)
    plain.searchParams.set('code_challenge_method', 'plain')
    expect(new URL((await code(plain.toString())).location ?? '').searchParams.get('error')).toBe(
      'invalid_request'
    )
    const paused = new RelyingParty({
      issuer: provider.issuer,
      clientId: 'application_paused',
      redirectUri: `${rig.url}/cb`,
      fetch: local,
    })
    await expect(
      paused.complete((await code((await paused.begin()).url)).location ?? '')
    ).rejects.toMatchObject({
      code: 'access_denied',
    })
  })
  test('a wrong client secret is refused before any code is looked at', async () => {
    const wrong = new RelyingParty({
      issuer: provider.issuer,
      clientId: 'application_rig',
      clientSecret: 'rck_wrong',
      redirectUri: `${rig.url}/cb`,
      fetch: local,
    })
    provider.decide({ person: alice, approve: true })
    const { url } = await wrong.begin()
    await expect(wrong.complete((await code(url)).location ?? '')).rejects.toMatchObject({
      code: 'invalid_client',
    })
  })
})

describe('ID token checks', () => {
  const sample = async (
    claims: Record<string, unknown>,
    alg: 'RS256' | 'ES256' = 'RS256',
    typ = 'JWT'
  ) =>
    provider.sign(alg, typ, {
      iss: provider.issuer,
      sub: 's',
      aud: 'application_rig',
      exp: clock + 300,
      iat: clock,
      nonce: 'n',
      ...claims,
    })
  const expected = () => ({
    issuer: provider.issuer,
    clientId: 'application_rig',
    nonce: 'n',
    now: clock,
  })
  const check = async (token: string, x = expected()) =>
    checkIdToken(await verifyJws(token, provider.jwks), x)

  test('every claim that matters is checked', async () => {
    expect((await check(await sample({}))).sub).toBe('s')
    expect((await check(await sample({}, 'ES256'))).sub).toBe('s')
    await expect(check(await sample({ iss: 'https://other.example' }))).rejects.toThrow('iss')
    await expect(check(await sample({ aud: 'application_es' }))).rejects.toThrow('aud')
    await expect(check(await sample({ azp: 'application_es' }))).rejects.toThrow('azp')
    await expect(check(await sample({ nonce: 'other' }))).rejects.toThrow('nonce')
    await expect(check(await sample({ exp: clock - 61 }))).rejects.toThrow('exp')
    await expect(check(await sample({ iat: clock + 61 }))).rejects.toThrow('iat')
    await expect(check(await sample({ sub: '' }))).rejects.toThrow('sub')
    await expect(check(await sample({}, 'RS256', 'logout+jwt'))).rejects.toThrow('typ')
    await expect(
      check(await sample({ at_hash: 'x' }), { ...expected(), accessToken: 't' } as never)
    ).rejects.toThrow('at_hash')
    await expect(
      check(await sample({ auth_time: clock - 1000 }), { ...expected(), maxAge: 100 } as never)
    ).rejects.toThrow('auth_time')
    expect(atHash('jHkWEdUXMU1BwAsC4vtUsZwnNvTIxEl0z9K3vx5KF0Y')).toBe('77QmUPtjPfzWtF2AnpK9RQ')
  })
  test('a changed token, an unsigned one and one signed by another key are refused', async () => {
    const token = await sample({})
    const [h, p, s] = token.split('.')
    const forged = Buffer.from(
      JSON.stringify({ ...JSON.parse(Buffer.from(p, 'base64url').toString()), sub: 'root' })
    ).toString('base64url')
    await expect(verifyJws(`${h}.${forged}.${s}`, provider.jwks)).rejects.toThrow('bad signature')
    const none = Buffer.from(JSON.stringify({ alg: 'none' })).toString('base64url')
    await expect(verifyJws(`${none}.${p}.`, provider.jwks)).rejects.toThrow('algorithm not allowed')
    const hs = Buffer.from(
      JSON.stringify({ alg: 'HS256', kid: provider.jwks.keys[0].kid })
    ).toString('base64url')
    await expect(verifyJws(`${hs}.${p}.${s}`, provider.jwks)).rejects.toThrow(
      'algorithm not allowed'
    )
    const swapped = Buffer.from(
      JSON.stringify({ alg: 'RS256', kid: provider.jwks.keys[1].kid })
    ).toString('base64url')
    await expect(verifyJws(`${swapped}.${p}.${s}`, provider.jwks)).rejects.toThrow(
      'key does not fit'
    )
    await expect(verifyJws(token, { keys: [] })).rejects.toThrow('unknown key')
    await expect(
      verifyJws(token, { keys: [provider.jwks.keys[0], provider.jwks.keys[0]] })
    ).rejects.toThrow('unknown key')
    for (const junk of ['', 'a.b', 'a.b.c.d', '!!.e30.e30', `${h}.${p}.${s}=`])
      await expect(verifyJws(junk, provider.jwks)).rejects.toBeInstanceOf(RigError)
  })
})

describe('what the application gets is what the person ticked', () => {
  test('an unticked permission is not in the scope and its route answers insufficient_scope', async () => {
    const s = await signIn(rp, ['servers'], ['profile', 'servers', 'servers.join'], alice, [
      'lobby',
    ])
    expect(s.scope).toEqual(['openid', 'profile', 'servers'])
    const list = await rp.api(s.id, 'GET', '/api/v1/oauth/servers')
    expect(list.json).toEqual([{ key: 'lobby' }])
    const join = await rp.join(s.id, 'vault', { password: 'open sesame' })
    expect(join.status).toBe(403)
    expect(join.json).toEqual({
      error: 'insufficient_scope',
      reason: { kind: 'off_account', control: 'scope:servers.join' },
    })
  })
  test('a per-server permission brings servers along, and a server that was not picked is the uniform 404', async () => {
    const s = await signIn(rp, ['servers.read'], ['profile', 'servers.read'], alice, ['lobby'])
    expect(s.scope).toEqual(['openid', 'profile', 'servers.read', 'servers'])
    expect((await rp.api(s.id, 'GET', '/api/v1/servers/lobby')).status).toBe(200)
    const unpicked = await rp.api(s.id, 'GET', '/api/v1/servers/team')
    const missing = await rp.api(s.id, 'GET', '/api/v1/servers/nowhere')
    expect(unpicked.status).toBe(404)
    expect(unpicked.body).toBe(missing.body)
    expect(unpicked.json).toEqual({ error: 'Server not found or wrong password' })
  })
  test('admin is granted only to a site admin who ticked it, and other grants can not be told apart', async () => {
    const asked = ['profile', 'admin']
    const nonAdmin = await signIn(es, ['admin'], asked, alice)
    const unticked = await signIn(es, [], asked, root)
    const ticked = await signIn(es, ['admin'], asked, root)
    expect(nonAdmin.scope).toEqual(['openid', 'profile'])
    expect(unticked.scope).toEqual(nonAdmin.scope)
    expect(Object.keys(unticked.claims).sort()).toEqual(Object.keys(nonAdmin.claims).sort())
    expect(ticked.scope).toEqual(['openid', 'profile', 'admin'])
    provider.decide({ person: root, approve: true, ticked: ['admin'] })
    const { url } = await rp.begin({ scopes: asked })
    const notMarked = await rp.complete((await code(url)).location ?? '')
    expect(notMarked.scope).toEqual(['openid', 'profile'])
  })
  test('never routes and undeclared routes refuse every token', async () => {
    const s = await signIn(rp, undefined, ['profile', 'servers', 'servers.join', 'messages.send'])
    expect((await rp.api(s.id, 'POST', '/api/v1/me/password', {})).status).toBe(403)
    expect((await rp.api(s.id, 'GET', '/api/v1/unknown')).status).toBe(403)
    expect(
      (await rp.api(s.id, 'POST', '/api/v1/channels/1/messages', { content: 'hi' })).status
    ).toBe(200)
  })
  test('user-info holds only the granted claims', async () => {
    const bare = await signIn(rp, [], ['profile'])
    expect(Object.keys(await rp.userinfo(bare.id)).sort()).toEqual([
      'name',
      'preferred_username',
      'sub',
    ])
    const roles = await signIn(
      rp,
      ['servers', 'servers.members.read'],
      ['profile', 'servers', 'servers.members.read'],
      alice,
      ['lobby']
    )
    expect((await rp.userinfo(roles.id)).groups).toEqual(['lobby', 'lobby:Staff'])
    expect(roles.claims.groups).toEqual(['lobby', 'lobby:Staff'])
  })
})

describe('joins as the person', () => {
  test("every answer equals the account's own; a joined server is added to the picks", async () => {
    const s = await signIn(
      rp,
      undefined,
      ['profile', 'servers', 'servers.join', 'servers.read'],
      alice,
      ['lobby']
    )
    const wrong = await rp.join(s.id, 'vault', { password: 'nope' })
    const closed = await rp.join(s.id, 'shut')
    const missing = await rp.join(s.id, 'nowhere')
    expect(wrong.status).toBe(404)
    expect(wrong.body).toBe(closed.body)
    expect(wrong.body).toBe(missing.body)
    const banned = await rp.join(s.id, 'gate')
    expect(banned.status).toBe(403)
    expect(banned.json).toEqual({ error: 'You are banned from this server' })
    expect((await rp.api(s.id, 'GET', '/api/v1/servers/vault')).status).toBe(404)
    const right = await rp.join(s.id, 'vault', { password: 'open sesame' })
    expect(right.status).toBe(200)
    expect((await rp.api(s.id, 'GET', '/api/v1/servers/vault')).status).toBe(200)
  })
  test('ten joins a day per grant, then a rate refusal about the application', async () => {
    const s = await signIn(rp, undefined, ['profile', 'servers', 'servers.join'])
    for (let i = 0; i < JOINS_PER_DAY; i++) expect((await rp.join(s.id, 'lobby')).status).toBe(200)
    const paced = await rp.join(s.id, 'lobby')
    expect(paced.status).toBe(429)
    expect(paced.json).toEqual({
      error: 'This application joined enough servers for you today',
      reason: { kind: 'rate', control: 'application_joins' },
    })
  })
})

describe('refresh', () => {
  test('rotation: the old token works once; a lost answer within 30 s gets the same successor; later reuse ends the family', async () => {
    const s = await signIn(rp, undefined, ['profile', 'servers', 'offline_access'])
    const first = s.refreshToken
    const firstAccess = s.accessToken
    const next = await rp.refresh(s.id)
    expect(next.id).toBe(s.id)
    expect(next.refreshToken).not.toBe(first)
    expect(next.accessToken).not.toBe(firstAccess)
    expect(next.sub).toBe(s.sub)
    const successor = next.refreshToken
    const lost = { ...next, refreshToken: first }
    rp.sessions.set(s.id, lost)
    clock += 29
    const replayed = await rp.refresh(s.id)
    expect(replayed.refreshToken).toBe(successor)
    rp.sessions.set(s.id, { ...replayed, refreshToken: first })
    clock += 2
    await expect(rp.refresh(s.id)).rejects.toMatchObject({ code: 'invalid_grant' })
    expect(rp.sessions.get(s.id)?.ended).toBe('refresh refused')
    const fresh = await signIn(rp, undefined, ['profile'])
    rp.sessions.set(fresh.id, { ...fresh, refreshToken: successor })
    await expect(rp.refresh(fresh.id)).rejects.toMatchObject({ code: 'invalid_grant' })
  })
  test('scopes can be narrowed, never widened; an application without the grant gets no refresh token', async () => {
    const s = await signIn(rp, undefined, ['profile', 'servers'])
    const narrowed = await rp.refresh(s.id, ['openid'])
    expect(narrowed.scope).toEqual(['openid'])
    await expect(rp.refresh(s.id, ['openid', 'messages.send'])).rejects.toMatchObject({
      code: 'invalid_scope',
    })
    const e = await signIn(es, undefined, ['profile'])
    await expect(es.refresh(e.id)).rejects.toMatchObject({ code: 'no_refresh_token' })
  })
})

describe('logout', () => {
  test('the rig asks the provider to sign out with the ID token as the hint', async () => {
    const s = await signIn(rp, undefined, ['profile'])
    const { url, state } = await rp.logoutUrl(s.id, 'st')
    const q = new URL(url).searchParams
    expect(url.startsWith(`${provider.issuer}/oauth/logout?`)).toBe(true)
    expect(q.get('id_token_hint')).toBe(s.idToken)
    expect(q.get('client_id')).toBe('application_rig')
    expect(q.get('post_logout_redirect_uri')).toBe(`${rig.url}/signed_out`)
    expect(state).toBe('st')
  })
  const logoutToken = (claims: Record<string, unknown>, typ = 'logout+jwt') =>
    provider.sign('RS256', typ, {
      iss: provider.issuer,
      aud: 'application_rig',
      iat: clock,
      exp: clock + 120,
      jti: `t-${Math.random()}`,
      events: { [BACKCHANNEL_EVENT]: {} },
      ...claims,
    })
  test('a back-channel token ends the session it names, once', async () => {
    const a = await signIn(rp, undefined, ['profile'])
    const b = await signIn(rp, undefined, ['profile'])
    const token = await logoutToken({ sub: a.sub, sid: a.sid })
    const post = (t: string) =>
      fetch(`${rig.url}/backchannel`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ logout_token: t }).toString(),
      })
    expect((await post(token)).status).toBe(200)
    expect(rp.sessions.get(a.id)?.ended).toBe('signed out by the provider')
    expect(rp.sessions.get(b.id)?.ended).toBeNull()
    expect((await post(token)).status).toBe(400)
    await expect(rp.api(a.id, 'GET', '/api/v1/oauth/servers')).rejects.toMatchObject({
      code: 'session_ended',
    })
    const everything = await logoutToken({ sub: b.sub })
    expect((await post(everything)).status).toBe(200)
    expect(rp.sessions.get(b.id)?.ended).toBe('signed out by the provider')
    const nobody = await logoutToken({ sub: 'someone-else', sid: 'no-such-session' })
    expect((await post(nobody)).status).toBe(204)
  })
  test('a logout token with a nonce, another audience, no event or the wrong type is refused', async () => {
    const s = await signIn(rp, undefined, ['profile'])
    const refuse = async (claims: Record<string, unknown>, typ?: string) =>
      expect(
        rp.backchannel(await logoutToken({ sub: s.sub, sid: s.sid, ...claims }, typ))
      ).rejects.toBeInstanceOf(RigError)
    await refuse({ nonce: 'n' })
    await refuse({ aud: 'application_es' })
    await refuse({ events: {} })
    await refuse({ iss: 'https://other.example' })
    await refuse({ exp: clock - 100 })
    await refuse({ sub: undefined, sid: undefined })
    await refuse({}, 'JWT')
    expect(rp.sessions.get(s.id)?.ended).toBeNull()
    const checked = checkLogoutToken(
      await verifyJws(await logoutToken({ sub: s.sub }), provider.jwks),
      { issuer: provider.issuer, clientId: 'application_rig', now: clock }
    )
    expect(checked).toMatchObject({ sub: s.sub, sid: null })
  })
  test('the provider delivers one token per session and no sub-only token to an application that needs the sid', async () => {
    const withBack = await startProvider({
      now,
      applications: [
        {
          id: 'application_rig',
          secret: 'rck_rig',
          redirects: ['http://127.0.0.1/cb'],
          scopes: [],
          grants: ['authorization_code'],
          backchannelUri: `${rig.url}/backchannel`,
          sessionRequired: true,
        },
      ],
    })
    const party = new RelyingParty({
      issuer: withBack.issuer,
      clientId: 'application_rig',
      clientSecret: 'rck_rig',
      redirectUri: `${rig.url}/cb`,
      fetch: local,
      now,
    })
    withBack.decide({ person: alice, approve: true })
    const s = await party.complete((await code((await party.begin()).url)).location ?? '')
    const token = await withBack.sign('RS256', 'logout+jwt', {
      iss: withBack.issuer,
      aud: 'application_rig',
      iat: clock,
      exp: clock + 120,
      jti: 'one',
      sub: s.sub,
      sid: s.sid,
      events: { [BACKCHANNEL_EVENT]: {} },
    })
    expect(await party.backchannel(token)).toEqual([s.id])
    await withBack.revokeGrant(withBack.grants[0].id)
    expect(withBack.delivered).toHaveLength(1)
    expect(withBack.delivered[0].uri).toBe(`${rig.url}/backchannel`)
    withBack.stop()
  })
})

describe('the device flow', () => {
  test('no link carries the code; the rig waits, slows down when told and ends with a session', async () => {
    const handle = await tv.deviceStart(['messages.read'])
    expect(handle.userCode).toMatch(/^[BCDFGHJKLMNPQRSTVWXZ]{4}-[BCDFGHJKLMNPQRSTVWXZ]{4}$/)
    expect(handle.verificationUri).toBe(`${provider.issuer}/device/`)
    expect(handle.interval).toBe(5)
    expect(await tv.devicePoll(handle)).toEqual({ status: 'pending', interval: 5 })
    expect(await tv.devicePoll(handle)).toEqual({ status: 'pending', interval: 10 })
    expect(provider.approveDevice(handle.userCode, { person: alice, approve: true }, false)).toBe(
      false
    )
    expect(provider.approveDevice('BCDF-GHJK', { person: alice, approve: true })).toBe(false)
    expect(provider.approveDevice(handle.userCode, { person: alice, approve: true })).toBe(true)
    clock += 10
    const done = await tv.devicePoll(handle)
    expect(done.status).toBe('done')
    if (done.status === 'done') {
      expect(done.session.scope).toEqual(['openid', 'messages.read', 'profile', 'servers'])
      expect(done.session.claims.preferred_username).toBe('alice')
    }
  })
  test('a refusal, an expired code, and the permissions that never go over a device', async () => {
    const denied = await tv.deviceStart()
    provider.approveDevice(denied.userCode, { person: alice, approve: false })
    expect(await tv.devicePoll(denied)).toEqual({ status: 'denied' })
    const late = await tv.deviceStart()
    clock += 601
    expect(await tv.devicePoll(late)).toEqual({ status: 'expired' })
    await expect(tv.deviceStart(['admin'])).rejects.toMatchObject({ code: 'invalid_scope' })
    await expect(rp.deviceStart()).rejects.toMatchObject({ code: 'invalid_client' })
  })
  test('a provider that offers a link with the code in it is refused', async () => {
    const linking: Fetch = async input =>
      input.endsWith('/.well-known/openid-configuration')
        ? fetch(input)
        : new Response(
            JSON.stringify({
              device_code: 'd',
              user_code: 'BCDF-GHJK',
              verification_uri: 'https://chat.example.com/device/',
              verification_uri_complete: 'https://chat.example.com/device/?code=BCDF-GHJK',
            })
          )
    const fooled = new RelyingParty({
      issuer: provider.issuer,
      clientId: 'application_tv',
      redirectUri: 'x',
      fetch: linking,
    })
    await expect(fooled.deviceStart()).rejects.toMatchObject({ code: 'complete_uri' })
  })
})

describe('the rig as a web service', () => {
  const get = (path: string) => fetch(`${rig.url}${path}`, { redirect: 'manual' })
  test('a browser run: /login, the provider, /cb, then /session shows the result', async () => {
    provider.decide({ person: alice, approve: true, ticked: ['servers'], servers: ['lobby'] })
    const start = await get('/login?scope=profile+servers')
    expect(start.status).toBe(302)
    const authorize = start.headers.get('location') ?? ''
    expect(authorize.startsWith(`${provider.issuer}/oauth/authorize?`)).toBe(true)
    const back = (await code(authorize)).location ?? ''
    expect(back.startsWith(`${rig.url}/cb?`)).toBe(true)
    const landed = await get(back.slice(rig.url.length))
    expect(landed.status).toBe(303)
    const session = await (await fetch(landed.headers.get('location') ?? '')).json()
    expect(session).toMatchObject({
      scope: ['openid', 'profile', 'servers'],
      refresh: true,
      ended: null,
    })
    expect(session.claims.preferred_username).toBe('alice')
    expect(JSON.stringify(session)).not.toContain('rca_')
    expect(JSON.stringify(session)).not.toContain('rcr_')
    const call = await fetch(`${rig.url}/api`, {
      method: 'POST',
      body: JSON.stringify({ id: session.id, method: 'GET', path: '/api/v1/oauth/servers' }),
    })
    expect((await call.json()).json).toEqual([{ key: 'lobby' }])
    const info = await (await get(`/userinfo?id=${session.id}`)).json()
    expect(info.preferred_username).toBe('alice')
    const out = await get(`/logout?id=${session.id}`)
    expect(out.status).toBe(302)
    expect(out.headers.get('location')).toContain('/oauth/logout?id_token_hint=')
  })
  test('errors are JSON with a code, and unknown paths are 404', async () => {
    const bad = await get('/cb?state=nope')
    expect(bad.status).toBe(400)
    expect(await bad.json()).toMatchObject({ error: 'state_mismatch' })
    expect((await get('/session?id=nope')).status).toBe(404)
    expect((await get('/nowhere')).status).toBe(404)
    expect((await fetch(`${rig.url}/device/poll?handle=x`, { method: 'POST' })).status).toBe(404)
    const root = await (await get('/')).json()
    expect(root).toMatchObject({ issuer: provider.issuer, client_id: 'application_rig' })
  })
})

describe('authenticator codes for the runs', () => {
  const rfcKey = new TextEncoder().encode('12345678901234567890')
  test('RFC 4226 appendix D and RFC 6238 appendix B', () => {
    const want = [
      '755224',
      '287082',
      '359152',
      '969429',
      '338314',
      '254676',
      '287922',
      '162583',
      '399871',
      '520489',
    ]
    want.forEach((c, i) => expect(hotp(rfcKey, i)).toBe(c))
    const rows: [number, string][] = [
      [59, '94287082'],
      [1111111109, '07081804'],
      [1111111111, '14050471'],
      [1234567890, '89005924'],
      [2000000000, '69279037'],
      [20000000000, '65353130'],
    ]
    for (const [t, c] of rows) expect(totp(rfcKey, t, 8)).toBe(c)
  })
  test('from the key as shown or the otpauth URI', () => {
    const key = 'GEZD GNBV GY3T QOJQ GEZD GNBV GY3T QOJQ'
    const uri =
      'otpauth://totp/Chat%20(chat.example.com):alice?secret=GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ&issuer=Chat%20(chat.example.com)&algorithm=SHA1&digits=6&period=30'
    expect(Array.from(base32Decode(key) ?? [])).toEqual(Array.from(rfcKey))
    expect(Array.from(secretOf(uri) ?? [])).toEqual(Array.from(rfcKey))
    expect(codeFor(key, 1_700_000_015)).toBe('732303')
    expect(codeFor(uri, 1_700_000_015)).toBe('732303')
    expect(codeFor('not a key!', 0)).toBeNull()
    expect(codeFor('otpauth://totp/x', 0)).toBeNull()
    expect(codeFor('', 0)).toBeNull()
  })
})

// An in-process provider for the rig's tests, built from the rules of the identity model: exact
// redirects with the loopback port free, PKCE S256, one-use codes, refresh rotation with a 30 s
// grace, permissions exactly as ticked, API calls as the person, device codes that are typed and
// never linked, and logout tokens. It binds 127.0.0.1 on a free port and calls nothing but the
// back-channel address of its own applications.
import { createHash, createHmac, randomBytes } from 'node:crypto'

export type Alg = 'RS256' | 'ES256'

export type FakeApplication = {
  id: string
  secret?: string
  redirects: string[]
  postLogout?: string[]
  scopes: string[]
  grants: ('authorization_code' | 'refresh_token' | 'device_code')[]
  alg?: Alg
  backchannelUri?: string
  sessionRequired?: boolean
  mayAskAdmin?: boolean
  paused?: boolean
}

export type FakeServer = {
  key: string
  password?: string
  closed?: boolean
  banned?: number[]
  members: number[]
}

export type FakePerson = {
  uid: number
  username: string
  name: string
  isSiteAdmin?: boolean
  roles?: Record<string, string[]>
}

export type Decision = {
  person: FakePerson
  approve: boolean
  ticked?: string[]
  servers?: string[]
  amr?: string[]
  authAge?: number
}

type Grant = {
  id: number
  application: string
  uid: number
  scopes: string[]
  servers: string[]
  sid: string
  joinsToday: number
  revoked: boolean
}

type Code = {
  grant: Grant
  challenge: string
  redirect: string
  nonce: string | null
  amr: string[]
  authTime: number
  expiresAt: number
  used: boolean
  issued: string[]
}

type Refresh = {
  grant: Grant
  family: string
  usedAt: number | null
  successor: string | null
  revoked: boolean
}

type Device = {
  application: string
  scopes: string[]
  userCode: string
  expiresAt: number
  interval: number
  lastPoll: number | null
  status: 'pending' | 'approved' | 'denied'
  grant: Grant | null
}

export const ACCESS_SECS = 3600
export const CODE_SECS = 60
export const REFRESH_GRACE_SECS = 30
export const DEVICE_SECS = 600
export const DEVICE_INTERVAL = 5
export const JOINS_PER_DAY = 10
export const BACKCHANNEL_EVENT = 'http://schemas.openid.net/event/backchannel-logout'
export const NOT_BY_DEVICE = ['admin', 'encrypted.read', 'encrypted.send']
export const UNIFORM_404 = 'Server not found or wrong password'

const PER_SERVER = [
  'servers.members.read',
  'messages.send',
  'moderation',
  'messages.read',
  'servers.read',
  'servers.manage',
  'calls',
]
const USER_CODE_ALPHABET = 'BCDFGHJKLMNPQRSTVWXZ'

const b64url = (bytes: Uint8Array | Buffer | ArrayBuffer) =>
  Buffer.from(bytes as ArrayBuffer).toString('base64url')
const secret = (prefix: string) => prefix + b64url(randomBytes(32))
const challengeOf = (verifier: string) =>
  b64url(createHash('sha256').update(verifier, 'ascii').digest())
const scopeTokenOk = (t: string) => /^[\x21\x23-\x5b\x5d-\x7e]{1,64}$/.test(t)

export const redirectMatches = (registered: readonly string[], asked: string) => {
  if (registered.includes(asked)) return true
  let a: URL
  try {
    a = new URL(asked)
  } catch {
    return false
  }
  if (a.protocol !== 'http:' || (a.hostname !== '127.0.0.1' && a.hostname !== '[::1]')) return false
  const portless = (s: string) =>
    s.replace(/^(http:\/\/(?:127\.0\.0\.1|\[::1\]))(?::\d+)?(?=[/?]|$)/, '$1')
  return registered.some(r => portless(r) === portless(asked))
}

export const normalizeTicks = (ticked: readonly string[]) => {
  const out = new Set(ticked)
  if (PER_SERVER.some(s => out.has(s))) out.add('servers')
  return [...out]
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers },
  })

const oauthError = (error: string, description: string, status = 400) =>
  json({ error, error_description: description }, status)

const apiError = (status: number, error: string, reason?: Record<string, unknown>) =>
  json(reason ? { error, reason } : { error }, status)

const insufficient = (scope: string) =>
  json(
    { error: 'insufficient_scope', reason: { kind: 'off_account', control: `scope:${scope}` } },
    403,
    { 'www-authenticate': 'Bearer error="insufficient_scope"' }
  )

export type ProviderOptions = {
  applications: FakeApplication[]
  servers?: FakeServer[]
  now?: () => number
  adminControl?: boolean
}

export const startProvider = async (options: ProviderOptions) => {
  const now = options.now ?? (() => Math.floor(Date.now() / 1000))
  const applications = new Map(options.applications.map(a => [a.id, a]))
  const servers = new Map((options.servers ?? []).map(s => [s.key, s]))
  const people = new Map<number, FakePerson>()
  const codes = new Map<string, Code>()
  const access = new Map<string, { grant: Grant; expiresAt: number }>()
  const refreshes = new Map<string, Refresh>()
  const devices = new Map<string, Device>()
  const grants: Grant[] = []
  const decisions: Decision[] = []
  const delivered: { uri: string; status: number }[] = []
  const pairwise = randomBytes(32)
  let jti = 0

  const rsa = (await crypto.subtle.generateKey(
    {
      name: 'RSASSA-PKCS1-v1_5',
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: 'SHA-256',
    },
    true,
    ['sign', 'verify']
  )) as CryptoKeyPair
  const ec = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
    'sign',
    'verify',
  ])) as CryptoKeyPair
  const publish = async (pair: CryptoKeyPair, alg: Alg) => {
    const jwk = await crypto.subtle.exportKey('jwk', pair.publicKey)
    const canonical =
      alg === 'RS256'
        ? `{"e":"${jwk.e}","kty":"RSA","n":"${jwk.n}"}`
        : `{"crv":"P-256","kty":"EC","x":"${jwk.x}","y":"${jwk.y}"}`
    const kid = b64url(createHash('sha256').update(canonical).digest())
    const shown =
      alg === 'RS256'
        ? { kty: 'RSA', n: jwk.n, e: jwk.e }
        : { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y }
    return { ...shown, kid, alg, use: 'sig' }
  }
  const jwks = { keys: [await publish(rsa, 'RS256'), await publish(ec, 'ES256')] }

  const sign = async (alg: Alg, typ: string, claims: Record<string, unknown>) => {
    const key = jwks.keys.find(k => k.alg === alg)
    const header = { alg, kid: key?.kid, typ }
    const input = `${b64url(Buffer.from(JSON.stringify(header)))}.${b64url(Buffer.from(JSON.stringify(claims)))}`
    const signature = await crypto.subtle.sign(
      alg === 'RS256' ? 'RSASSA-PKCS1-v1_5' : { name: 'ECDSA', hash: 'SHA-256' },
      alg === 'RS256' ? rsa.privateKey : ec.privateKey,
      Buffer.from(input)
    )
    return `${input}.${b64url(signature)}`
  }

  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: req => handle(req),
  })
  const issuer = `http://127.0.0.1:${server.port}`

  const subjectOf = (application: string, uid: number) =>
    createHmac('sha256', pairwise).update(`rchat-sub1\0${application}\0${uid}`).digest('base64url')

  const groupsOf = (person: FakePerson, picked: string[]) =>
    picked.flatMap(s => [s, ...(person.roles?.[s] ?? []).map(r => `${s}:${r}`)])

  const idToken = (
    application: FakeApplication,
    grant: Grant,
    c: Code | null,
    accessToken: string
  ) => {
    const person = people.get(grant.uid)
    const at = now()
    const digest = createHash('sha256').update(accessToken, 'ascii').digest()
    const amr = c?.amr ?? ['pwd']
    return sign(application.alg ?? 'RS256', 'JWT', {
      iss: issuer,
      sub: subjectOf(application.id, grant.uid),
      aud: application.id,
      azp: application.id,
      exp: at + 300,
      iat: at,
      auth_time: c?.authTime ?? at,
      ...(c?.nonce ? { nonce: c.nonce } : {}),
      sid: grant.sid,
      amr,
      acr: amr.includes('mfa') ? 'urn:rchat:acr:2fa' : 'urn:rchat:acr:1fa',
      at_hash: b64url(digest.subarray(0, 16)),
      ...(grant.scopes.includes('profile') && person
        ? {
            preferred_username: person.username,
            name: person.name,
            picture: `${issuer}/api/v1/avatars/${subjectOf(`avatar:${application.id}`, grant.uid).slice(0, 22)}.png?v=1`,
            updated_at: 1,
            rchat_instance: new URL(issuer).host,
          }
        : {}),
      ...(grant.scopes.includes('servers.members.read') && person
        ? { groups: groupsOf(person, grant.servers) }
        : {}),
    })
  }

  const tokens = async (
    application: FakeApplication,
    grant: Grant,
    c: Code | null,
    family?: string
  ) => {
    const accessToken = secret('rca_')
    access.set(accessToken, { grant, expiresAt: now() + ACCESS_SECS })
    c?.issued.push(accessToken)
    const body: Record<string, unknown> = {
      access_token: accessToken,
      token_type: 'Bearer',
      expires_in: ACCESS_SECS,
      scope: grant.scopes.join(' '),
      id_token: await idToken(application, grant, c, accessToken),
    }
    if (application.grants.includes('refresh_token')) {
      const refreshToken = secret('rcr_')
      refreshes.set(refreshToken, {
        grant,
        family: family ?? secret('fam_'),
        usedAt: null,
        successor: null,
        revoked: false,
      })
      c?.issued.push(refreshToken)
      body.refresh_token = refreshToken
    }
    return body
  }

  const clientOf = (req: Request, form: URLSearchParams) => {
    const basic = /^Basic (.+)$/.exec(req.headers.get('authorization') ?? '')
    const [id, given] = basic
      ? Buffer.from(basic[1], 'base64').toString('utf8').split(':').map(decodeURIComponent)
      : [form.get('client_id') ?? '', form.get('client_secret') ?? undefined]
    const application = applications.get(id ?? '')
    if (!application) return null
    return application.secret === undefined || application.secret === given ? application : null
  }

  const newGrant = (application: FakeApplication, d: Decision, asked: string[]) => {
    const admin =
      d.person.isSiteAdmin === true &&
      application.mayAskAdmin === true &&
      options.adminControl === true
    const ticked = d.ticked ?? asked
    const scopes = normalizeTicks(
      asked.filter(s => ticked.includes(s) || s === 'openid' || s === 'profile')
    ).filter(s => s !== 'admin' || admin)
    people.set(d.person.uid, d.person)
    const mine = [...servers.values()].filter(s => s.members.includes(d.person.uid)).map(s => s.key)
    const grant: Grant = {
      id: grants.length + 1,
      application: application.id,
      uid: d.person.uid,
      scopes,
      servers: (d.servers ?? mine).filter(s => mine.includes(s)),
      sid: secret('sid_').slice(0, 20),
      joinsToday: 0,
      revoked: false,
    }
    grants.push(grant)
    return grant
  }

  const authorize = (q: URLSearchParams) => {
    const application = applications.get(q.get('client_id') ?? '')
    if (!application) return apiError(400, 'This application is not known here')
    const redirect = q.get('redirect_uri')
    if (!redirect || !redirectMatches(application.redirects, redirect))
      return apiError(400, 'This application sent a return address it did not register')
    const back = (params: Record<string, string>) => {
      const to = new URL(redirect)
      for (const [k, v] of Object.entries(params)) to.searchParams.set(k, v)
      const state = q.get('state')
      if (state !== null) to.searchParams.set('state', state)
      to.searchParams.set('iss', issuer)
      return new Response(null, { status: 302, headers: { location: to.toString() } })
    }
    const refuse = (error: string, description: string) =>
      back({ error, error_description: description })
    if (application.paused) return refuse('access_denied', 'This application is paused')
    if (q.get('request'))
      return refuse('request_not_supported', 'Request objects are not supported')
    if (q.get('response_type') !== 'code')
      return refuse('unsupported_response_type', 'Only response_type=code is supported')
    if (!application.grants.includes('authorization_code'))
      return refuse('unauthorized_client', 'This application can not use this flow')
    const challenge = q.get('code_challenge') ?? ''
    if (q.get('code_challenge_method') !== 'S256' || !/^[A-Za-z0-9_-]{43}$/.test(challenge))
      return refuse('invalid_request', 'PKCE with S256 is required')
    const asked = (q.get('scope') ?? '').split(' ').filter(Boolean)
    if (asked.some(t => !scopeTokenOk(t)))
      return refuse('invalid_scope', 'Scope values must be plain ASCII')
    if (!asked.includes('openid')) return refuse('invalid_scope', 'Ask for openid')
    if (asked.some(s => !application.scopes.includes(s) && s !== 'openid' && s !== 'profile'))
      return refuse('invalid_scope', 'This application may not ask for one of these scopes')
    const prompt = (q.get('prompt') ?? '').split(' ').filter(Boolean)
    const decision = decisions.shift()
    if (!decision)
      return refuse(
        prompt.includes('none') ? 'login_required' : 'access_denied',
        'Sign-in was not allowed'
      )
    if (!decision.approve) return refuse('access_denied', 'Sign-in was not allowed')
    const grant = newGrant(application, decision, [...new Set([...asked, 'profile'])])
    const code = secret('rcc_')
    codes.set(code, {
      grant,
      challenge,
      redirect,
      nonce: q.get('nonce'),
      amr: decision.amr ?? ['pwd'],
      authTime: now() - (decision.authAge ?? 0),
      expiresAt: now() + CODE_SECS,
      used: false,
      issued: [],
    })
    return back({ code })
  }

  const revokeIssued = (c: Code) => {
    for (const token of c.issued) {
      access.delete(token)
      const r = refreshes.get(token)
      if (r) r.revoked = true
    }
  }

  const revokeFamily = (family: string) => {
    for (const r of refreshes.values()) if (r.family === family) r.revoked = true
  }

  const token = async (req: Request) => {
    const form = new URLSearchParams(await req.text())
    const application = clientOf(req, form)
    if (!application) return oauthError('invalid_client', 'This application is not known here', 401)
    const invalid = (description: string) => oauthError('invalid_grant', description)
    switch (form.get('grant_type')) {
      case 'authorization_code': {
        const c = codes.get(form.get('code') ?? '')
        if (!c || c.grant.application !== application.id) return invalid('That code is not valid')
        if (c.used) {
          revokeIssued(c)
          return invalid('That code was used before')
        }
        c.used = true
        if (now() >= c.expiresAt || c.grant.revoked) return invalid('That code expired')
        if (form.get('redirect_uri') !== c.redirect) return invalid('The return address changed')
        const verifier = form.get('code_verifier') ?? ''
        if (!/^[A-Za-z0-9._~-]{43,128}$/.test(verifier) || challengeOf(verifier) !== c.challenge)
          return invalid('The code verifier does not match')
        return json(await tokens(application, c.grant, c))
      }
      case 'refresh_token': {
        const given = form.get('refresh_token') ?? ''
        const r = refreshes.get(given)
        if (!r || r.revoked || r.grant.revoked || r.grant.application !== application.id)
          return invalid('That sign-in ended')
        if (r.usedAt !== null) {
          const kept = r.successor ? (JSON.parse(r.successor) as Record<string, unknown>) : null
          if (kept && now() - r.usedAt < REFRESH_GRACE_SECS) return json(kept)
          revokeFamily(r.family)
          return invalid('That sign-in ended')
        }
        const narrowed = form.get('scope')?.split(' ').filter(Boolean)
        if (narrowed?.some(s => !r.grant.scopes.includes(s)))
          return oauthError('invalid_scope', 'Scopes can be narrowed, never widened')
        const body = await tokens(application, r.grant, null, r.family)
        if (narrowed) body.scope = narrowed.join(' ')
        r.usedAt = now()
        r.successor = JSON.stringify(body)
        return json(body)
      }
      case 'urn:ietf:params:oauth:grant-type:device_code': {
        const d = devices.get(form.get('device_code') ?? '')
        if (!d || d.application !== application.id) return invalid('That code is not valid')
        if (now() >= d.expiresAt) return oauthError('expired_token', 'That code expired')
        const fast = d.lastPoll !== null && now() - d.lastPoll < d.interval
        d.lastPoll = now()
        if (d.status === 'denied') return oauthError('access_denied', 'Sign-in was not allowed')
        if (fast) {
          d.interval += 5
          return oauthError('slow_down', 'Waiting for approval')
        }
        if (d.status === 'pending' || !d.grant)
          return oauthError('authorization_pending', 'Waiting for approval')
        devices.delete(form.get('device_code') ?? '')
        return json(await tokens(application, d.grant, null))
      }
      default:
        return oauthError('unsupported_grant_type', 'This application can not sign in that way')
    }
  }

  const deviceAuthorization = async (req: Request) => {
    const form = new URLSearchParams(await req.text())
    const application = clientOf(req, form)
    if (!application || !application.grants.includes('device_code'))
      return oauthError('invalid_client', 'This application is not known here', 401)
    const scopes = (form.get('scope') ?? '').split(' ').filter(Boolean)
    if (scopes.some(s => NOT_BY_DEVICE.includes(s) || !scopeTokenOk(s)))
      return oauthError('invalid_scope', 'This application may not ask for one of these scopes')
    const letters = [...randomBytes(8)].map(b => USER_CODE_ALPHABET[b % USER_CODE_ALPHABET.length])
    const userCode = `${letters.slice(0, 4).join('')}-${letters.slice(4).join('')}`
    const deviceCode = secret('rcd_')
    devices.set(deviceCode, {
      application: application.id,
      scopes,
      userCode,
      expiresAt: now() + DEVICE_SECS,
      interval: DEVICE_INTERVAL,
      lastPoll: null,
      status: 'pending',
      grant: null,
    })
    return json({
      device_code: deviceCode,
      user_code: userCode,
      verification_uri: `${issuer}/device/`,
      expires_in: DEVICE_SECS,
      interval: DEVICE_INTERVAL,
    })
  }

  const bearer = (req: Request) => {
    const given = /^Bearer (.+)$/.exec(req.headers.get('authorization') ?? '')?.[1] ?? ''
    const held = access.get(given)
    return held && !held.grant.revoked && now() < held.expiresAt ? held.grant : null
  }

  const invalidToken = () =>
    json({ error: 'invalid_token' }, 401, { 'www-authenticate': 'Bearer error="invalid_token"' })

  const userinfo = (req: Request) => {
    const grant = bearer(req)
    if (!grant) return invalidToken()
    if (!grant.scopes.includes('openid')) return insufficient('openid')
    const person = people.get(grant.uid)
    return json({
      sub: subjectOf(grant.application, grant.uid),
      ...(grant.scopes.includes('profile') && person
        ? { preferred_username: person.username, name: person.name }
        : {}),
      ...(grant.scopes.includes('servers.members.read') && person
        ? { groups: groupsOf(person, grant.servers) }
        : {}),
    })
  }

  // What the person's own request would get for a join: the same answers for every account.
  const personJoin = (s: FakeServer | undefined, uid: number, password: unknown) => {
    if (!s || s.closed) return apiError(404, UNIFORM_404)
    if (s.banned?.includes(uid)) return apiError(403, 'You are banned from this server')
    if (s.password !== undefined && s.password !== password) return apiError(404, UNIFORM_404)
    if (!s.members.includes(uid)) s.members.push(uid)
    return json({ joined: s.key })
  }

  const api = async (req: Request, path: string) => {
    const grant = bearer(req)
    if (!grant) return invalidToken()
    const has = (scope: string) => grant.scopes.includes(scope)
    const seg = path.split('/').filter(Boolean)
    if (req.method === 'GET' && path === '/oauth/servers') {
      if (!has('servers')) return insufficient('servers')
      return json(grant.servers.map(key => ({ key })))
    }
    if (seg[0] === 'servers' && seg.length === 2 && req.method === 'GET') {
      if (!has('servers.read')) return insufficient('servers.read')
      const s = servers.get(seg[1])
      if (!s || !grant.servers.includes(seg[1]) || !s.members.includes(grant.uid))
        return apiError(404, UNIFORM_404)
      return json({ key: s.key, members: s.members.length })
    }
    if (seg[0] === 'servers' && seg[2] === 'join' && seg.length === 3 && req.method === 'POST') {
      if (!has('servers.join')) return insufficient('servers.join')
      if (grant.joinsToday >= JOINS_PER_DAY)
        return apiError(429, 'This application joined enough servers for you today', {
          kind: 'rate',
          control: 'application_joins',
        })
      const body = (await req.json().catch(() => ({}))) as { password?: unknown }
      const answer = personJoin(servers.get(seg[1]), grant.uid, body.password)
      if (answer.status === 200) {
        grant.joinsToday += 1
        if (!grant.servers.includes(seg[1])) grant.servers.push(seg[1])
      }
      return answer
    }
    if (seg[0] === 'channels' && seg[2] === 'messages' && req.method === 'POST')
      return has('messages.send') ? json({ id: 1 }) : insufficient('messages.send')
    if (seg[0] === 'me' && seg.length > 1) return insufficient('never')
    return insufficient('undeclared')
  }

  const logoutTokens = async (application: FakeApplication, sub: string, sids: string[]) => {
    const each = application.sessionRequired ? sids : [...sids, null]
    const out: string[] = []
    for (const sid of each) {
      jti += 1
      out.push(
        await sign(application.alg ?? 'RS256', 'logout+jwt', {
          iss: issuer,
          aud: application.id,
          iat: now(),
          exp: now() + 120,
          jti: `jti-${jti}`,
          sub,
          ...(sid ? { sid } : {}),
          events: { [BACKCHANNEL_EVENT]: {} },
        })
      )
    }
    return out
  }

  const deliver = async (application: FakeApplication, logoutToken: string) => {
    const uri = application.backchannelUri
    if (!uri || new URL(uri).hostname !== '127.0.0.1') return
    const res = await fetch(uri, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ logout_token: logoutToken }).toString(),
    })
    delivered.push({ uri, status: res.status })
  }

  const logout = async (q: URLSearchParams) => {
    const application = applications.get(q.get('client_id') ?? '')
    const to = q.get('post_logout_redirect_uri')
    if (!application || !to || !(application.postLogout ?? []).includes(to))
      return apiError(400, 'This application sent a return address it did not register')
    const hint = q.get('id_token_hint') ?? ''
    const sid = (() => {
      try {
        const claims = JSON.parse(
          Buffer.from(hint.split('.')[1] ?? '', 'base64url').toString('utf8')
        )
        return typeof claims.sid === 'string' ? claims.sid : null
      } catch {
        return null
      }
    })()
    if (sid) await provider.signOut(sid)
    const back = new URL(to)
    const state = q.get('state')
    if (state !== null) back.searchParams.set('state', state)
    return new Response(null, { status: 302, headers: { location: back.toString() } })
  }

  const handle = async (req: Request): Promise<Response> => {
    const at = new URL(req.url)
    const route = `${req.method} ${at.pathname}`
    if (at.pathname.startsWith('/api/v1/')) return api(req, at.pathname.slice('/api/v1'.length))
    switch (route) {
      case 'GET /.well-known/openid-configuration':
        return json({
          issuer,
          authorization_endpoint: `${issuer}/oauth/authorize`,
          token_endpoint: `${issuer}/oauth/token`,
          userinfo_endpoint: `${issuer}/oauth/userinfo`,
          jwks_uri: `${issuer}/oauth/jwks`,
          device_authorization_endpoint: `${issuer}/oauth/device_authorization`,
          end_session_endpoint: `${issuer}/oauth/logout`,
          response_types_supported: ['code'],
          subject_types_supported: ['pairwise'],
          id_token_signing_alg_values_supported: ['RS256', 'ES256'],
          code_challenge_methods_supported: ['S256'],
          authorization_response_iss_parameter_supported: true,
          backchannel_logout_supported: true,
          backchannel_logout_session_supported: true,
        })
      case 'GET /oauth/jwks':
        return json(jwks)
      case 'GET /oauth/authorize':
        return authorize(at.searchParams)
      case 'POST /oauth/token':
        return token(req)
      case 'GET /oauth/userinfo':
        return userinfo(req)
      case 'POST /oauth/device_authorization':
        return deviceAuthorization(req)
      case 'GET /oauth/logout':
        return logout(at.searchParams)
      default:
        return apiError(404, 'Not found')
    }
  }

  const provider = {
    issuer,
    port: server.port,
    jwks,
    grants,
    delivered,
    decide: (d: Decision) => decisions.push(d),
    sign,
    // The person types the code into a client where they are signed in; a code taken from a
    // link is never accepted.
    approveDevice: (userCode: string, d: Decision, typed = true) => {
      const device = [...devices.values()].find(x => x.userCode === userCode && now() < x.expiresAt)
      const application = device ? applications.get(device.application) : undefined
      if (!device || !application || !typed) return false
      device.status = d.approve ? 'approved' : 'denied'
      device.grant = d.approve
        ? newGrant(application, d, [...new Set([...device.scopes, 'profile'])])
        : null
      return true
    },
    signOut: async (sid: string) => {
      for (const grant of grants.filter(g => g.sid === sid && !g.revoked)) {
        const application = applications.get(grant.application)
        for (const r of refreshes.values())
          if (r.grant === grant && !grant.scopes.includes('offline_access')) r.revoked = true
        for (const [k, v] of access) if (v.grant === grant) access.delete(k)
        if (!application) continue
        const [first] = await logoutTokens(application, subjectOf(application.id, grant.uid), [sid])
        await deliver(application, first)
      }
    },
    revokeGrant: async (id: number) => {
      const grant = grants.find(g => g.id === id)
      const application = grant ? applications.get(grant.application) : undefined
      if (!grant || !application) return
      grant.revoked = true
      const sub = subjectOf(application.id, grant.uid)
      for (const t of await logoutTokens(application, sub, [grant.sid]))
        await deliver(application, t)
    },
    stop: () => server.stop(true),
  }
  return provider
}

// A relying party of "Sign in with" an instance: discovery, the code flow with PKCE, ID token
// checks, refresh, user-info, API calls and joins as the person, the device flow, and logout.
import {
  RigError,
  authorizeUrl,
  checkIdToken,
  checkLogoutToken,
  parseCallback,
  pkcePair,
  randomToken,
  verifyJws,
  type Claims,
  type Jwks,
} from './oidc'

export type Fetch = (input: string, init?: RequestInit) => Promise<Response>

export type Config = {
  issuer: string
  clientId: string
  clientSecret?: string
  redirectUri: string
  postLogoutRedirectUri?: string
  fetch?: Fetch
  now?: () => number
}

export type Discovery = {
  issuer: string
  authorization_endpoint: string
  token_endpoint: string
  userinfo_endpoint: string
  jwks_uri: string
  end_session_endpoint?: string
  device_authorization_endpoint?: string
  revocation_endpoint?: string
  code_challenge_methods_supported?: string[]
  id_token_signing_alg_values_supported?: string[]
}

export type Session = {
  id: string
  sub: string
  sid: string | null
  scope: string[]
  claims: Claims
  idToken: string
  accessToken: string
  refreshToken: string | null
  expiresAt: number
  webhook: unknown
  ended: string | null
}

type Pending = { state: string; nonce: string; verifier: string; maxAge?: number }

export type BeginOptions = {
  scopes?: string[]
  prompt?: string
  maxAge?: number
  acrValues?: string
  joinServers?: string[]
  loginHint?: string
}

export type DeviceHandle = {
  deviceCode: string
  userCode: string
  verificationUri: string
  interval: number
  expiresAt: number
}

export type DevicePoll =
  | { status: 'pending'; interval: number }
  | { status: 'denied' | 'expired' }
  | { status: 'done'; session: Session }

type TokenResponse = {
  access_token?: unknown
  token_type?: unknown
  expires_in?: unknown
  scope?: unknown
  refresh_token?: unknown
  id_token?: unknown
  webhook?: unknown
  error?: unknown
  error_description?: unknown
}

const text = (v: unknown) => (typeof v === 'string' ? v : null)

const parsed = (raw: string): unknown => {
  try {
    return raw ? JSON.parse(raw) : null
  } catch {
    return null
  }
}

export class RelyingParty {
  readonly sessions = new Map<string, Session>()
  readonly seenLogoutTokens = new Set<string>()
  private pending = new Map<string, Pending>()
  private discovery: Discovery | null = null
  private jwks: Jwks | null = null
  private fetch: Fetch
  private now: () => number

  constructor(readonly config: Config) {
    this.fetch = config.fetch ?? ((input, init) => fetch(input, init))
    this.now = config.now ?? (() => Math.floor(Date.now() / 1000))
  }

  async discover(): Promise<Discovery> {
    if (this.discovery) return this.discovery
    const res = await this.fetch(`${this.config.issuer}/.well-known/openid-configuration`)
    if (!res.ok) throw new RigError('discovery_failed', `discovery answered ${res.status}`)
    const doc = (await res.json()) as Discovery
    if (doc.issuer !== this.config.issuer) throw new RigError('issuer_mismatch')
    if (!doc.code_challenge_methods_supported?.includes('S256'))
      throw new RigError('no_pkce', 'the provider does not list S256')
    this.discovery = doc
    return doc
  }

  private async keys(refresh = false): Promise<Jwks> {
    if (this.jwks && !refresh) return this.jwks
    const res = await this.fetch((await this.discover()).jwks_uri)
    if (!res.ok) throw new RigError('jwks_failed', `the keys answered ${res.status}`)
    this.jwks = (await res.json()) as Jwks
    return this.jwks
  }

  private async verify(token: string) {
    try {
      return await verifyJws(token, await this.keys())
    } catch (e) {
      if (!(e instanceof RigError) || e.message !== 'unknown key') throw e
      return verifyJws(token, await this.keys(true))
    }
  }

  async begin(o: BeginOptions = {}) {
    const d = await this.discover()
    const { verifier, challenge } = pkcePair()
    const state = randomToken(16)
    const nonce = randomToken(16)
    this.pending.set(state, { state, nonce, verifier, maxAge: o.maxAge })
    const url = authorizeUrl(
      d.authorization_endpoint,
      this.config.clientId,
      this.config.redirectUri,
      {
        scopes: o.scopes ?? ['profile'],
        state,
        nonce,
        challenge,
        prompt: o.prompt,
        maxAge: o.maxAge,
        acrValues: o.acrValues,
        joinServers: o.joinServers,
        loginHint: o.loginHint,
      }
    )
    return { url, state }
  }

  private auth(body: URLSearchParams): Record<string, string> {
    const headers: Record<string, string> = { 'content-type': 'application/x-www-form-urlencoded' }
    const { clientId, clientSecret } = this.config
    if (clientSecret === undefined) body.set('client_id', clientId)
    else
      headers.authorization = `Basic ${Buffer.from(
        `${encodeURIComponent(clientId)}:${encodeURIComponent(clientSecret)}`
      ).toString('base64')}`
    return headers
  }

  private async token(body: URLSearchParams): Promise<TokenResponse> {
    const d = await this.discover()
    const headers = this.auth(body)
    const res = await this.fetch(d.token_endpoint, {
      method: 'POST',
      headers,
      body: body.toString(),
    })
    const json = (await res.json().catch(() => ({}))) as TokenResponse
    const error = text(json.error)
    if (!res.ok || error)
      throw new RigError(error ?? `http_${res.status}`, text(json.error_description) ?? undefined)
    return json
  }

  private async session(
    t: TokenResponse,
    nonce: string | null,
    maxAge: number | undefined,
    keep?: Session
  ): Promise<Session> {
    const accessToken = text(t.access_token)
    if (!accessToken || text(t.token_type)?.toLowerCase() !== 'bearer')
      throw new RigError('invalid_token_response')
    const idToken = text(t.id_token) ?? keep?.idToken ?? null
    if (!idToken) throw new RigError('invalid_token_response', 'no ID token')
    const fresh = text(t.id_token) !== null
    const claims = fresh
      ? checkIdToken(await this.verify(idToken), {
          issuer: this.config.issuer,
          clientId: this.config.clientId,
          nonce,
          now: this.now(),
          accessToken,
          maxAge,
        })
      : (keep?.claims ?? {})
    if (keep && claims.sub !== keep.sub) throw new RigError('invalid_token', 'the subject changed')
    const session: Session = {
      id: keep?.id ?? randomToken(12),
      sub: String(claims.sub),
      sid: text(claims.sid),
      scope: (text(t.scope) ?? keep?.scope.join(' ') ?? '').split(' ').filter(Boolean),
      claims,
      idToken,
      accessToken,
      refreshToken: text(t.refresh_token) ?? null,
      expiresAt: this.now() + (typeof t.expires_in === 'number' ? t.expires_in : 0),
      webhook: t.webhook ?? keep?.webhook ?? null,
      ended: null,
    }
    this.sessions.set(session.id, session)
    return session
  }

  async complete(callbackUrl: string): Promise<Session> {
    const state = new URL(callbackUrl).searchParams.get('state') ?? ''
    const pending = this.pending.get(state)
    if (!pending) throw new RigError('state_mismatch')
    this.pending.delete(state)
    const { code } = parseCallback(callbackUrl, { state, issuer: this.config.issuer })
    const t = await this.token(
      new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: this.config.redirectUri,
        code_verifier: pending.verifier,
      })
    )
    return this.session(t, pending.nonce, pending.maxAge)
  }

  private live(id: string): Session {
    const s = this.sessions.get(id)
    if (!s) throw new RigError('no_session')
    if (s.ended) throw new RigError('session_ended', s.ended)
    return s
  }

  async refresh(id: string, scope?: string[]): Promise<Session> {
    const s = this.live(id)
    if (!s.refreshToken) throw new RigError('no_refresh_token')
    const body = new URLSearchParams({ grant_type: 'refresh_token', refresh_token: s.refreshToken })
    if (scope) body.set('scope', scope.join(' '))
    try {
      return await this.session(await this.token(body), null, undefined, s)
    } catch (e) {
      if (e instanceof RigError && e.code === 'invalid_grant') s.ended = 'refresh refused'
      throw e
    }
  }

  // Calls the instance's API as the person. The answer is returned whatever its status, so a run
  // can compare it with what the person's own request gets.
  async api(id: string, method: string, path: string, body?: unknown) {
    const s = this.live(id)
    const res = await this.fetch(`${this.config.issuer}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${s.accessToken}`,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    const raw = await res.text()
    return { status: res.status, body: raw, json: parsed(raw) }
  }

  async userinfo(id: string): Promise<Claims> {
    const s = this.live(id)
    const d = await this.discover()
    const res = await this.fetch(d.userinfo_endpoint, {
      headers: { authorization: `Bearer ${s.accessToken}` },
    })
    if (!res.ok) throw new RigError('userinfo_failed', `user-info answered ${res.status}`)
    const claims = (await res.json()) as Claims
    if (claims.sub !== s.sub) throw new RigError('invalid_token', 'user-info is about someone else')
    return claims
  }

  join(id: string, server: string, body: Record<string, unknown> = {}) {
    return this.api(id, 'POST', `/api/v1/servers/${encodeURIComponent(server)}/join`, body)
  }

  leave(id: string, server: string) {
    return this.api(id, 'POST', `/api/v1/servers/${encodeURIComponent(server)}/leave`)
  }

  async logoutUrl(id: string, state = randomToken(8)) {
    const s = this.sessions.get(id)
    if (!s) throw new RigError('no_session')
    const d = await this.discover()
    if (!d.end_session_endpoint) throw new RigError('no_logout_endpoint')
    const q = new URLSearchParams({ id_token_hint: s.idToken, client_id: this.config.clientId })
    if (this.config.postLogoutRedirectUri) {
      q.set('post_logout_redirect_uri', this.config.postLogoutRedirectUri)
      q.set('state', state)
    }
    return { url: `${d.end_session_endpoint}?${q.toString()}`, state }
  }

  // The provider's back-channel request: ends the sessions the token names. A token seen before
  // is refused, so a replayed request does nothing.
  async backchannel(logoutToken: string) {
    const checked = checkLogoutToken(await this.verify(logoutToken), {
      issuer: this.config.issuer,
      clientId: this.config.clientId,
      now: this.now(),
    })
    if (this.seenLogoutTokens.has(checked.jti))
      throw new RigError('invalid_token', 'jti seen before')
    this.seenLogoutTokens.add(checked.jti)
    const ended: string[] = []
    for (const s of this.sessions.values()) {
      const named = checked.sid !== null ? s.sid === checked.sid : s.sub === checked.sub
      if (named && !s.ended) {
        s.ended = 'signed out by the provider'
        ended.push(s.id)
      }
    }
    return ended
  }

  async deviceStart(scopes: string[] = ['profile']): Promise<DeviceHandle> {
    const d = await this.discover()
    if (!d.device_authorization_endpoint) throw new RigError('no_device_endpoint')
    const body = new URLSearchParams({ scope: [...new Set(['openid', ...scopes])].join(' ') })
    const headers = this.auth(body)
    const res = await this.fetch(d.device_authorization_endpoint, {
      method: 'POST',
      headers,
      body: body.toString(),
    })
    const json = (await res.json().catch(() => ({}))) as Record<string, unknown>
    if (!res.ok) throw new RigError(text(json.error) ?? `http_${res.status}`)
    if (json.verification_uri_complete !== undefined)
      throw new RigError('complete_uri', 'the provider offered a link that carries the code')
    const deviceCode = text(json.device_code)
    const userCode = text(json.user_code)
    const verificationUri = text(json.verification_uri)
    if (!deviceCode || !userCode || !verificationUri) throw new RigError('invalid_device_response')
    return {
      deviceCode,
      userCode,
      verificationUri,
      interval: typeof json.interval === 'number' ? json.interval : 5,
      expiresAt: this.now() + (typeof json.expires_in === 'number' ? json.expires_in : 600),
    }
  }

  // One poll. `slow_down` raises the handle's interval by 5 seconds, as RFC 8628 3.5 says.
  async devicePoll(handle: DeviceHandle): Promise<DevicePoll> {
    try {
      const t = await this.token(
        new URLSearchParams({
          grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
          device_code: handle.deviceCode,
        })
      )
      return { status: 'done', session: await this.session(t, null, undefined) }
    } catch (e) {
      if (!(e instanceof RigError)) throw e
      if (e.code === 'authorization_pending')
        return { status: 'pending', interval: handle.interval }
      if (e.code === 'slow_down') {
        handle.interval += 5
        return { status: 'pending', interval: handle.interval }
      }
      if (e.code === 'access_denied') return { status: 'denied' }
      if (e.code === 'expired_token') return { status: 'expired' }
      throw e
    }
  }
}

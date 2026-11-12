// The rig as a small web service, for browser runs: /login starts a sign-in, /cb finishes it,
// /backchannel takes the provider's logout tokens, and /session, /api, /join and /device let a
// run look at and drive what the rig holds. It binds 127.0.0.1 only.
import { RelyingParty, type BeginOptions, type Config, type DeviceHandle } from './client'
import { RigError } from './oidc'

export type RigOptions = Omit<Config, 'redirectUri'> & { port?: number; scopes?: string[] }

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  })

const failure = (e: unknown) =>
  e instanceof RigError
    ? json({ error: e.code, error_description: e.message }, 400)
    : json({ error: 'server_error' }, 500)

const list = (value: string | null) => (value ? value.split(/[ ,]+/).filter(Boolean) : undefined)

export const startRig = (options: RigOptions) => {
  const devices = new Map<string, DeviceHandle>()
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: options.port ?? 0,
    fetch: req => handle(req).catch(failure),
  })
  const url = `http://127.0.0.1:${server.port}`
  const rp = new RelyingParty({
    ...options,
    redirectUri: `${url}/cb`,
    postLogoutRedirectUri: options.postLogoutRedirectUri ?? `${url}/signed_out`,
  })

  const handle = async (req: Request): Promise<Response> => {
    const at = new URL(req.url)
    const q = at.searchParams
    const route = `${req.method} ${at.pathname}`
    switch (route) {
      case 'GET /':
        return json({
          issuer: options.issuer,
          client_id: options.clientId,
          sessions: rp.sessions.size,
        })
      case 'GET /login': {
        const begin: BeginOptions = {
          scopes: list(q.get('scope')) ?? options.scopes,
          prompt: q.get('prompt') ?? undefined,
          joinServers: list(q.get('join_servers')),
          acrValues: q.get('acr_values') ?? undefined,
          loginHint: q.get('login_hint') ?? undefined,
        }
        const maxAge = q.get('max_age')
        if (maxAge !== null && /^\d{1,9}$/.test(maxAge)) begin.maxAge = Number(maxAge)
        return Response.redirect((await rp.begin(begin)).url, 302)
      }
      case 'GET /cb': {
        const s = await rp.complete(req.url)
        return Response.redirect(`${url}/session?id=${encodeURIComponent(s.id)}`, 303)
      }
      case 'GET /session': {
        const s = rp.sessions.get(q.get('id') ?? '')
        if (!s) return json({ error: 'no_session' }, 404)
        return json({
          id: s.id,
          sub: s.sub,
          sid: s.sid,
          scope: s.scope,
          claims: s.claims,
          refresh: s.refreshToken !== null,
          webhook: s.webhook,
          ended: s.ended,
        })
      }
      case 'POST /refresh':
        return json({ id: (await rp.refresh(q.get('id') ?? '')).id })
      case 'GET /userinfo':
        return json(await rp.userinfo(q.get('id') ?? ''))
      case 'POST /api': {
        const call = (await req.json()) as {
          id: string
          method: string
          path: string
          body?: unknown
        }
        const answer = await rp.api(call.id, call.method, call.path, call.body)
        return json(answer)
      }
      case 'POST /join': {
        const call = (await req.json()) as {
          id: string
          server: string
          body?: Record<string, unknown>
        }
        return json(await rp.join(call.id, call.server, call.body))
      }
      case 'POST /backchannel': {
        const form = new URLSearchParams(await req.text())
        const ended = await rp.backchannel(form.get('logout_token') ?? '')
        return new Response(null, { status: ended.length ? 200 : 204 })
      }
      case 'GET /logout': {
        const { url: to } = await rp.logoutUrl(q.get('id') ?? '')
        return Response.redirect(to, 302)
      }
      case 'GET /signed_out':
        return json({ signed_out: true, state: q.get('state') })
      case 'POST /device/start': {
        const handle = await rp.deviceStart(list(q.get('scope')) ?? options.scopes)
        devices.set(handle.deviceCode, handle)
        return json({
          handle: handle.deviceCode,
          user_code: handle.userCode,
          verification_uri: handle.verificationUri,
          interval: handle.interval,
        })
      }
      case 'POST /device/poll': {
        const handle = devices.get(q.get('handle') ?? '')
        if (!handle) return json({ error: 'no_device_request' }, 404)
        const poll = await rp.devicePoll(handle)
        if (poll.status !== 'pending') devices.delete(handle.deviceCode)
        return json(poll.status === 'done' ? { status: 'done', id: poll.session.id } : poll)
      }
      default:
        return json({ error: 'not_found' }, 404)
    }
  }

  return { url, port: server.port, rp, stop: () => server.stop(true) }
}
